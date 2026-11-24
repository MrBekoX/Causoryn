// analyze.go — go/parser + go/ast ile graph çıkarımı (M1-Go).
//
// Çıkarım disiplini (PROTOCOL.md resolution tablosu — dürüstlük sözleşmesi):
//   - Aynı package içindeki tanımlı fonksiyona bare-ident çağrı → verified
//     (go/ast declaration eşleşmesi; kaynak-içi sembol).
//   - Package-qualified çağrı (pkg.Func; pkg analiz setindeki package) →
//     heuristic + ambiguity (go/types semantik çözümleme YOK — ad kuralı).
//   - Import local adı eşleşen / analiz seti dışı package çağrısı →
//     heuristic + UnknownExternal (çağrı metni hedef olarak temsil edilir).
//   - Benzersiz metot adı → heuristic; birden çok aday → unresolved +
//     aday listesi; arayüz metodu adı → heuristic + UnknownExternal.
//   - Hiç eşleşmeyen ifade → unresolved + UnknownExternal (çağrı metni);
//     uydurma hedef ÜRETİLMEZ.
//
// Determinizm: dosyalar relativePath sıralı işlenir; node/edge/evidence
// kanonik anahtarla sıralanır; saat okunmaz; map yineleme sırası çıktıya
// sırtlanmaz (tüm çıktı kümeleri sıralanır).
package analyze

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"path"
	"sort"
	"strconv"
	"strings"
)

// SourceFile — worker'a gelen tek kaynak dosya (hash'i main hesaplar).
type SourceFile struct {
	RelativePath string
	Content      string
	SourceHash   string
}

// ModuleFile — opsiyonel go.mod dosya girdisi (modül yolu → tam import çözümlemesi).
type ModuleFile struct {
	RelativePath string
	Content      string
}

// Analyze sonucu — main bu alanları doğrudan Response'a kopyalar.
type Result struct {
	State         string // "ready" | "partial"
	CoverageRatio float64
	Warnings      []string
	Diagnostics   []Diagnostic
	Nodes         []Node
	Edges         []Edge
	Evidence      []Evidence // kept edge kanıtlarının dedupe edilmiş listesi
}

// pkgKey — Go paket kimliği: normalize edilmiş dizin yolu ("." kök için) + package adı.
// Aynı dizindeki çok-dosyalı Go paketleri aynı pkgKey'i paylaşır; farklı
// dizinlerdeki iki `package main` veya aynı adlı alt paketler ayrı tutulur.
type pkgKey struct {
	dir  string
	name string
}

type importSpec struct {
	localName  string // yerel ad (alias veya son yol segmenti)
	importPath string // tırnaksız tam import yolu
	aliased    bool   // açık alias verilmişse true
}

type goModRoot struct {
	modulePath string
	rootDir    string
}

type fileCtx struct {
	relativePath string
	dir          string
	content      string
	hash         string
	pkgName      string
	pkgKey       pkgKey
	imports      map[string]importSpec // import local adı → importSpec ("_"/"." hariç)
	importList   []importSpec
	f            *ast.File
	depthFlagged bool
}

type funcInfo struct {
	file   *fileCtx
	decl   *ast.FuncDecl
	pkg    string
	pkgKey pkgKey
	name   string
	recv   string // "" → top-level func; değilse alıcı tip adı
	qname  string
}

type typeInfo struct {
	file   *fileCtx
	spec   *ast.TypeSpec
	pkg    string
	pkgKey pkgKey
	name   string
	qname  string
	kind   string // Class | Interface | Type
}

// depthProbe — ast.Walk ile gövde başına maksimum derinlik ölçümü.
// Visit(nil) çağrıları Walk'ın exit sinyalidir; asla nil döndürmeyiz,
// böylece derinlik sayacı dengede kalır.
type depthProbe struct {
	max   int
	depth int
}

func (p *depthProbe) Visit(n ast.Node) ast.Visitor {
	if n == nil {
		p.depth--
		return nil
	}
	p.depth++
	if p.depth > p.max {
		p.max = p.depth
	}
	return p
}

// callTarget — tek çağrı ifadesinin çözümleme kararı.
type callTarget struct {
	ref        NodeRef
	resolution string
	ambiguity  *Ambiguity
	rationale  string
	// nil (skip): builtin vb. — kenar üretilmez.
}

func receiverTypeName(fd *ast.FuncDecl) string {
	if fd.Recv == nil || len(fd.Recv.List) == 0 {
		return ""
	}
	t := fd.Recv.List[0].Type
	for {
		switch v := t.(type) {
		case *ast.StarExpr:
			t = v.X
		case *ast.IndexExpr:
			t = v.X
		case *ast.IndexListExpr:
			t = v.X
		case *ast.ParenExpr:
			t = v.X
		case *ast.Ident:
			return v.Name
		default:
			return ""
		}
	}
}

func pkgDirOf(relPath string) string {
	dir := path.Dir(strings.ReplaceAll(relPath, "\\", "/"))
	if dir == "" || dir == "/" {
		return "."
	}
	return dir
}

func stripLineCommentOutsideQuotes(line string) string {
	inQuote := false
	escaped := false
	for i := 0; i < len(line); i++ {
		ch := line[i]
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' && inQuote {
			escaped = true
			continue
		}
		if ch == '"' {
			inQuote = !inQuote
			continue
		}
		if !inQuote && ch == '/' && i+1 < len(line) && line[i+1] == '/' {
			return line[:i]
		}
	}
	return line
}

func parseGoModModulePath(content string) string {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	for _, rawLine := range strings.Split(normalized, "\n") {
		line := strings.TrimSpace(stripLineCommentOutsideQuotes(rawLine))
		if !strings.HasPrefix(line, "module") {
			continue
		}
		rest := line[len("module"):]
		if len(rest) == 0 || (rest[0] != ' ' && rest[0] != '\t') {
			continue
		}
		rest = strings.TrimSpace(rest)
		if rest == "" {
			continue
		}
		var modPath string
		if strings.HasPrefix(rest, "\"") {
			endIdx := strings.IndexByte(rest[1:], '"')
			if endIdx < 0 {
				continue
			}
			unquoted, err := strconv.Unquote(rest[:endIdx+2])
			if err != nil {
				continue
			}
			modPath = unquoted
		} else {
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				continue
			}
			modPath = fields[0]
		}
		modPath = strings.TrimRight(strings.TrimSpace(modPath), "/")
		if modPath != "" {
			return modPath
		}
	}
	return ""
}

func parseModuleFiles(moduleFiles []ModuleFile) []goModRoot {
	var roots []goModRoot
	for _, mf := range moduleFiles {
		modPath := parseGoModModulePath(mf.Content)
		if modPath == "" {
			continue
		}
		roots = append(roots, goModRoot{
			modulePath: modPath,
			rootDir:    pkgDirOf(mf.RelativePath),
		})
	}
	// Uzun modül yolu öneki önce gelir (iç içe go.mod modülleri için deterministik).
	sort.Slice(roots, func(i, j int) bool {
		if len(roots[i].modulePath) != len(roots[j].modulePath) {
			return len(roots[i].modulePath) > len(roots[j].modulePath)
		}
		if roots[i].modulePath != roots[j].modulePath {
			return roots[i].modulePath < roots[j].modulePath
		}
		return roots[i].rootDir < roots[j].rootDir
	})
	return roots
}

func resolveImportDirByGoMod(modRoots []goModRoot, importPath string) (string, bool) {
	cleaned := strings.TrimRight(importPath, "/")
	for _, mr := range modRoots {
		if cleaned == mr.modulePath {
			return mr.rootDir, true
		}
		if strings.HasPrefix(cleaned, mr.modulePath+"/") {
			sub := strings.TrimPrefix(cleaned, mr.modulePath+"/")
			if mr.rootDir == "." {
				return path.Clean(sub), true
			}
			return path.Join(mr.rootDir, sub), true
		}
	}
	return "", false
}

func dirIsUnderRoot(dir, rootDir string) bool {
	if rootDir == "." {
		return true
	}
	return dir == rootDir || strings.HasPrefix(dir, rootDir+"/")
}

func fileHasGoverningGoMod(modRoots []goModRoot, fileDir string) bool {
	for _, mr := range modRoots {
		if dirIsUnderRoot(fileDir, mr.rootDir) {
			return true
		}
	}
	return false
}

// Analyze — verilen dosyalar (relativePath sıralı) üzerinden graph üretir.
// maxNodes ≤ 0 → MaxResponseNodes uygulanır.
func Analyze(files []SourceFile, maxNodes int) Result {
	return AnalyzeWithModules(files, nil, maxNodes)
}

// AnalyzeWithModules — verilen Go kaynak dosyaları ve opsiyonel go.mod
// dosyaları üzerinden graph üretir.
func AnalyzeWithModules(files []SourceFile, moduleFiles []ModuleFile, maxNodes int) Result {
	if len(files) > 1 {
		// Savunma katmanı: main zaten sıralar; determinizm için burada da.
		for i := 1; i < len(files); i++ {
			for j := i; j > 0 && files[j].RelativePath < files[j-1].RelativePath; j-- {
				files[j], files[j-1] = files[j-1], files[j]
			}
		}
	}
	budget := maxNodes
	if budget <= 0 || budget > MaxResponseNodes {
		budget = MaxResponseNodes
	}

	modRoots := parseModuleFiles(moduleFiles)
	fset := token.NewFileSet()
	var warnings []string
	var diagnostics []Diagnostic

	var fileCtxs []*fileCtx
	var funcs []*funcInfo
	var types []*typeInfo

	// 1) Parse + declaration toplama (dosya sıralı, belge sıralı).
	for _, sf := range files {
		ctx := &fileCtx{
			relativePath: sf.RelativePath,
			dir:          pkgDirOf(sf.RelativePath),
			content:      sf.Content,
			hash:         sf.SourceHash,
			imports:      map[string]importSpec{},
		}
		fileCtxs = append(fileCtxs, ctx)
		parsed, err := parser.ParseFile(fset, sf.RelativePath, sf.Content, parser.SkipObjectResolution)
		if err != nil {
			if list, ok := err.(scanner.ErrorList); ok {
				for _, e := range list {
					line := 0
					if e.Pos.IsValid() {
						line = e.Pos.Line
					}
					diagnostics = append(diagnostics, Diagnostic{
						RelativePath: sf.RelativePath,
						Code:         "GOPARSE",
						Message:      e.Msg,
						Line:         line,
					})
				}
			} else {
				diagnostics = append(diagnostics, Diagnostic{
					RelativePath: sf.RelativePath,
					Code:         "GOPARSE",
					Message:      err.Error(),
					Line:         0,
				})
			}
		}
		if parsed == nil {
			continue
		}
		ctx.f = parsed
		ctx.pkgName = parsed.Name.Name
		ctx.pkgKey = pkgKey{dir: ctx.dir, name: ctx.pkgName}
		for _, imp := range parsed.Imports {
			pathValue, uerr := strconv.Unquote(imp.Path.Value)
			if uerr != nil {
				continue
			}
			local := ""
			aliased := false
			if imp.Name != nil {
				local = imp.Name.Name
				aliased = true
			}
			if local == "" {
				local = pathValue
				if idx := strings.LastIndex(local, "/"); idx >= 0 {
					local = local[idx+1:]
				}
			}
			if local != "_" && local != "." && local != "" {
				spec := importSpec{
					localName:  local,
					importPath: pathValue,
					aliased:    aliased,
				}
				ctx.imports[local] = spec
				ctx.importList = append(ctx.importList, spec)
			}
		}
		for _, decl := range parsed.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				recv := receiverTypeName(d)
				fi := &funcInfo{file: ctx, decl: d, pkg: ctx.pkgName, pkgKey: ctx.pkgKey, name: d.Name.Name, recv: recv}
				if recv != "" {
					fi.qname = ctx.pkgName + "." + recv + "." + d.Name.Name
				} else {
					fi.qname = ctx.pkgName + "." + d.Name.Name
				}
				funcs = append(funcs, fi)
			case *ast.GenDecl:
				if d.Tok != token.TYPE {
					continue
				}
				for _, spec := range d.Specs {
					ts, ok := spec.(*ast.TypeSpec)
					if !ok {
						continue
					}
					ti := &typeInfo{file: ctx, spec: ts, pkg: ctx.pkgName, pkgKey: ctx.pkgKey, name: ts.Name.Name, qname: ctx.pkgName + "." + ts.Name.Name}
					switch ts.Type.(type) {
					case *ast.StructType:
						ti.kind = "Class"
					case *ast.InterfaceType:
						ti.kind = "Interface"
					default:
						ti.kind = "Type"
					}
					types = append(types, ti)
				}
			}
		}
	}

	// 2) Dizin+paket anahtarlı indeksler (aynı dizindeki çok-dosyalı paketler birleşir,
	//    farklı dizinlerdeki aynı adlı paketler asla karışmaz).
	pkgFuncs := map[pkgKey]map[string]*funcInfo{} // pkgKey(dir, name) → top-level func adı
	methodsByName := map[string][]*funcInfo{}     // metot adı → adaylar (belge sıralı)
	ifaceMethods := map[string][]string{}         // arayüz metodu adı → arayüz qname'leri
	typeIndex := map[pkgKey]map[string]*typeInfo{}
	pkgsByDirSet := map[string]map[pkgKey]bool{}
	importablePkgSet := map[pkgKey]bool{}

	for _, ctx := range fileCtxs {
		if ctx.f == nil || ctx.pkgName == "" {
			continue
		}
		if !strings.HasSuffix(ctx.pkgName, "_test") {
			if pkgsByDirSet[ctx.dir] == nil {
				pkgsByDirSet[ctx.dir] = map[pkgKey]bool{}
			}
			pkgsByDirSet[ctx.dir][ctx.pkgKey] = true
			if ctx.pkgName != "main" {
				importablePkgSet[ctx.pkgKey] = true
			}
		}
	}

	pkgsByDir := map[string][]pkgKey{}
	for dir, set := range pkgsByDirSet {
		list := make([]pkgKey, 0, len(set))
		for pk := range set {
			list = append(list, pk)
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].dir != list[j].dir {
				return list[i].dir < list[j].dir
			}
			return list[i].name < list[j].name
		})
		pkgsByDir[dir] = list
	}

	importablePkgs := make([]pkgKey, 0, len(importablePkgSet))
	for pk := range importablePkgSet {
		importablePkgs = append(importablePkgs, pk)
	}
	sort.Slice(importablePkgs, func(i, j int) bool {
		if importablePkgs[i].dir != importablePkgs[j].dir {
			return importablePkgs[i].dir < importablePkgs[j].dir
		}
		return importablePkgs[i].name < importablePkgs[j].name
	})

	importablePkgsByName := map[string][]pkgKey{}
	for _, pk := range importablePkgs {
		importablePkgsByName[pk.name] = append(importablePkgsByName[pk.name], pk)
	}

	// Unaliased import'larda dizin adı ile beyan edilen package adı farklıysa
	// (ör. my-pkg dizininde `package mypkg` veya `/v2` sürüm yolu), go.mod ile
	// çözülen paketin beyan edilen adını da dosyanın import tablosuna bağla.
	for _, ctx := range fileCtxs {
		for _, spec := range ctx.importList {
			if spec.aliased {
				continue
			}
			if targetDir, ok := resolveImportDirByGoMod(modRoots, spec.importPath); ok {
				if dirPkgs := pkgsByDir[targetDir]; len(dirPkgs) == 1 {
					declared := dirPkgs[0].name
					if declared != "" && declared != "_" && declared != "." {
						if _, exists := ctx.imports[declared]; !exists {
							ctx.imports[declared] = importSpec{
								localName:  declared,
								importPath: spec.importPath,
								aliased:    false,
							}
						}
					}
				}
			}
		}
	}

	for _, ti := range types {
		if typeIndex[ti.pkgKey] == nil {
			typeIndex[ti.pkgKey] = map[string]*typeInfo{}
		}
		typeIndex[ti.pkgKey][ti.name] = ti
		if ti.kind != "Interface" {
			continue
		}
		it, ok := ti.spec.Type.(*ast.InterfaceType)
		if !ok {
			continue
		}
		for _, field := range it.Methods.List {
			for _, nm := range field.Names {
				ifaceMethods[nm.Name] = append(ifaceMethods[nm.Name], ti.qname)
			}
		}
	}
	for _, fi := range funcs {
		if fi.recv == "" {
			m := pkgFuncs[fi.pkgKey]
			if m == nil {
				m = map[string]*funcInfo{}
				pkgFuncs[fi.pkgKey] = m
			}
			m[fi.name] = fi
		} else {
			methodsByName[fi.name] = append(methodsByName[fi.name], fi)
		}
	}

	// 3) Node kümeleri.
	nodeSet := map[string]Node{}
	addNode := func(n Node) NodeRef {
		ref := NodeRef{Kind: n.Kind, QualifiedName: n.QualifiedName, RelativePath: n.RelativePath}
		key := nodeKey(ref)
		if _, exists := nodeSet[key]; !exists {
			nodeSet[key] = n
		}
		return ref
	}
	fileRef := func(ctx *fileCtx) NodeRef {
		return addNode(Node{
			Kind:          "File",
			QualifiedName: ctx.relativePath,
			Language:      "go",
			RelativePath:  ctx.relativePath,
			Attributes:    map[string]any{"sourceHash": ctx.hash},
		})
	}
	ensureNodeRef := func(ref NodeRef) {
		key := nodeKey(ref)
		if _, exists := nodeSet[key]; !exists {
			addNode(Node{Kind: ref.Kind, QualifiedName: ref.QualifiedName, Language: "go", RelativePath: ref.RelativePath, Attributes: map[string]any{}})
		}
	}
	funcRef := func(fi *funcInfo) NodeRef {
		kind := "Function"
		if fi.recv != "" {
			kind = "Method"
		}
		return addNode(Node{Kind: kind, QualifiedName: fi.qname, Language: "go", RelativePath: fi.file.relativePath, Attributes: map[string]any{}})
	}
	typeRef := func(ti *typeInfo) NodeRef {
		return addNode(Node{Kind: ti.kind, QualifiedName: ti.qname, Language: "go", RelativePath: ti.file.relativePath, Attributes: map[string]any{}})
	}

	declSpan := func(ctx *fileCtx, from, to token.Pos) *Span {
		start := fset.Position(from)
		end := fset.Position(to)
		return &Span{
			RelativePath: ctx.relativePath,
			StartLine:    start.Line,
			EndLine:      end.Line,
			SourceHash:   ctx.hash,
		}
	}

	// 4) Kenar toplayıcı (dedupe + evidence birleştirme).
	edgeSet := map[string]int{}
	var edges []Edge
	addEdge := func(e Edge) {
		ensureNodeRef(e.From)
		ensureNodeRef(e.To)
		key := edgeKey(e)
		if idx, ok := edgeSet[key]; ok {
			merged := edges[idx].Evidence
			for _, ev := range e.Evidence {
				merged = appendEvidenceUnique(merged, ev)
			}
			edges[idx].Evidence = merged
			return
		}
		edgeSet[key] = len(edges)
		edges = append(edges, e)
	}

	// 5) CONTAINS — File → üst-düzey bildirimler; Class/Interface/Type → metotları.
	for _, fi := range funcs {
		ref := funcRef(fi)
		addEdge(Edge{
			Kind:       EdgeContains,
			From:       fileRef(fi.file),
			To:         ref,
			Resolution: ResolutionVerified,
			Evidence: []Evidence{{
				Kind:            EvidenceKindAstSpan,
				Span:            declSpan(fi.file, fi.decl.Pos(), fi.decl.End()),
				AnalyzerID:      AnalyzerID,
				AnalyzerVersion: AnalyzerVersion,
				Rationale: fmt.Sprintf(
					"CONTAINS: %s '%s' bildirimini kapsar (go/ast declaration aralığı).",
					fi.file.relativePath, fi.qname,
				),
			}},
		})
		if fi.recv != "" {
			if ti, ok := typeIndex[fi.pkgKey][fi.recv]; ok {
				addEdge(Edge{
					Kind:       EdgeContains,
					From:       typeRef(ti),
					To:         ref,
					Resolution: ResolutionVerified,
					Evidence: []Evidence{{
						Kind:            EvidenceKindAstSpan,
						Span:            declSpan(fi.file, fi.decl.Pos(), fi.decl.End()),
						AnalyzerID:      AnalyzerID,
						AnalyzerVersion: AnalyzerVersion,
						Rationale: fmt.Sprintf(
							"CONTAINS: %s '%s' metodunu kapsar (go/ast alıcı eşleşmesi).",
							ti.qname, fi.qname,
						),
					}},
				})
			}
		}
	}
	for _, ti := range types {
		addEdge(Edge{
			Kind:       EdgeContains,
			From:       fileRef(ti.file),
			To:         typeRef(ti),
			Resolution: ResolutionVerified,
			Evidence: []Evidence{{
				Kind:            EvidenceKindAstSpan,
				Span:            declSpan(ti.file, ti.spec.Pos(), ti.spec.End()),
				AnalyzerID:      AnalyzerID,
				AnalyzerVersion: AnalyzerVersion,
				Rationale: fmt.Sprintf(
					"CONTAINS: %s '%s' bildirimini kapsar (go/ast type spec aralığı).",
					ti.file.relativePath, ti.qname,
				),
			}},
		})
	}

	// 6) CALLS + ROUTES_TO — gövde gezinmesi (derinlik ölçümlü).
	flagDepth := func(fctx *fileCtx) {
		if fctx.depthFlagged {
			return
		}
		fctx.depthFlagged = true
		diagnostic := Diagnostic{
			RelativePath: fctx.relativePath,
			Code:         "GO_AST_DEPTH",
			Message:      fmt.Sprintf("AST gezinme derinliği %d aşıldı; derin gövdeler çağrı çıkarımına dahil edilmedi", MaxAstDepth),
			Line:         0,
		}
		diagnostics = append(diagnostics, diagnostic)
		warnings = append(warnings, fmt.Sprintf("%s: AST derinlik sınırı aşan gövdeler atlandı (%s)", AnalyzerID, fctx.relativePath))
	}
	actx := &analysisContext{
		fset:                 fset,
		modRoots:             modRoots,
		pkgFuncs:             pkgFuncs,
		pkgsByDir:            pkgsByDir,
		importablePkgs:       importablePkgs,
		importablePkgsByName: importablePkgsByName,
		methodsByName:        methodsByName,
		ifaceMethods:         ifaceMethods,
		addNode:              addNode,
		addEdge:              addEdge,
		warnings:             &warnings,
		declSpan:             declSpan,
	}
	for _, fi := range funcs {
		if fi.decl.Body == nil {
			continue
		}
		probe := &depthProbe{}
		ast.Walk(probe, fi.decl.Body)
		if probe.max > MaxAstDepth {
			flagDepth(fi.file)
			continue
		}
		calls := collectCallExprs(fi.decl.Body)
		for _, call := range calls {
			if match := matchRoute(call); match != nil {
				handleRoute(actx, fi, match, call)
				continue
			}
			resolveAndAddCallEdge(actx, fi, call)
		}
	}

	// 7) Kanonik sıralama + node bütçesi + evidence birleşimi.
	nodes := make([]Node, 0, len(nodeSet))
	for _, n := range nodeSet {
		nodes = append(nodes, n)
	}
	sortNodes(nodes)
	if len(nodes) > budget {
		kept := make(map[string]bool, budget)
		for _, n := range nodes[:budget] {
			kept[nodeKey(NodeRef{Kind: n.Kind, QualifiedName: n.QualifiedName, RelativePath: n.RelativePath})] = true
		}
		droppedEdges := 0
		trimmed := edges[:0]
		for _, e := range edges {
			if kept[nodeKey(e.From)] && kept[nodeKey(e.To)] {
				trimmed = append(trimmed, e)
			} else {
				droppedEdges++
			}
		}
		edges = trimmed
		diagnostics = append(diagnostics, Diagnostic{
			RelativePath: "",
			Code:         "RESPONSE_TRUNCATED",
			Message: fmt.Sprintf(
				"yanıt node bütçesi (%d) aşıldı; %d node yayınlandı, uçları yayınlanmayan %d kenar düştü (dangling yok)",
				budget, budget, droppedEdges,
			),
			Line: 0,
		})
		nodes = nodes[:budget]
	}
	sortEdges(edges)

	evidenceSet := map[string]bool{}
	var evidence []Evidence
	for _, e := range edges {
		for _, ev := range e.Evidence {
			key := evidenceKey(ev)
			if !evidenceSet[key] {
				evidenceSet[key] = true
				evidence = append(evidence, ev)
			}
		}
	}
	sortEvidence(evidence)

	verified := 0
	for _, e := range edges {
		if e.Resolution == ResolutionVerified {
			verified++
		}
	}
	coverage := 1.0
	if len(edges) > 0 {
		coverage = round4(float64(verified) / float64(len(edges)))
	}

	state := "ready"
	if len(diagnostics) > 0 || len(warnings) > 0 {
		state = "partial"
	}
	if warnings == nil {
		warnings = []string{}
	}
	if diagnostics == nil {
		diagnostics = []Diagnostic{}
	}

	return Result{
		State:         state,
		CoverageRatio: coverage,
		Warnings:      warnings,
		Diagnostics:   diagnostics,
		Nodes:         nodes,
		Edges:         edges,
		Evidence:      evidence,
	}
}

// --------------------------------------------------------------------
// Çağrı çözümleme (resolution tablosu)
// --------------------------------------------------------------------

func resolveAndAddCallEdge(actx *analysisContext, fi *funcInfo, call *ast.CallExpr) {
	if id, ok := call.Fun.(*ast.Ident); ok && goBuiltins[id.Name] {
		return
	}
	target := classifyExpr(actx, fi, call.Fun)
	if target == nil {
		return
	}
	span := actx.declSpan(fi.file, call.Pos(), call.End())
	evidence := []Evidence{{
		Kind:            EvidenceKindAstSpan,
		Span:            span,
		AnalyzerID:      AnalyzerID,
		AnalyzerVersion: AnalyzerVersion,
		Rationale:       target.rationale,
	}}
	actx.addEdge(Edge{
		Kind:       EdgeCalls,
		From:       NodeRef{Kind: funcKind(fi), QualifiedName: fi.qname, RelativePath: fi.file.relativePath},
		To:         target.ref,
		Resolution: target.resolution,
		Evidence:   evidence,
		Ambiguity:  target.ambiguity,
	})
}

func funcKind(fi *funcInfo) string {
	if fi.recv != "" {
		return "Method"
	}
	return "Function"
}

func formatCandidateLabels(candidates []*funcInfo) []string {
	qnameCount := map[string]int{}
	for _, c := range candidates {
		qnameCount[c.qname]++
	}
	labels := make([]string, 0, len(candidates))
	for _, c := range candidates {
		if qnameCount[c.qname] > 1 {
			labels = append(labels, fmt.Sprintf("%s (%s)", c.qname, c.file.relativePath))
		} else {
			labels = append(labels, c.qname)
		}
	}
	sortStrings(labels)
	return labels
}

func resolveImportedSelectorCall(
	actx *analysisContext,
	fi *funcInfo,
	imp importSpec,
	selName string,
	text string,
) *callTarget {
	// 1) go.mod tam modül yolu eşleşmesi → verified!
	if targetDir, matchedMod := resolveImportDirByGoMod(actx.modRoots, imp.importPath); matchedMod {
		dirPkgs := actx.pkgsByDir[targetDir]
		if len(dirPkgs) == 1 {
			targetPkg := dirPkgs[0]
			if callee, ok := actx.pkgFuncs[targetPkg][selName]; ok && callee.recv == "" {
				return &callTarget{
					ref:        NodeRef{Kind: "Function", QualifiedName: callee.qname, RelativePath: callee.file.relativePath},
					resolution: ResolutionVerified,
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; import yolu '%s' go.mod ile '%s' dizinine kesin çözümlendi (verified).",
						fi.qname, callee.qname, imp.importPath, targetDir,
					),
				}
			}
			return &callTarget{
				ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
				resolution: ResolutionUnresolved,
				rationale: fmt.Sprintf(
					"CALLS: '%s' go.mod ile çözümlenen '%s' (%s) paketinde tanımlı değil; uydurma hedef üretilmedi (unresolved).",
					text, targetPkg.name, targetDir,
				),
			}
		}
		if len(dirPkgs) > 1 {
			var callees []*funcInfo
			for _, pk := range dirPkgs {
				if callee, ok := actx.pkgFuncs[pk][selName]; ok && callee.recv == "" {
					callees = append(callees, callee)
				}
			}
			if len(callees) > 1 {
				labels := formatCandidateLabels(callees)
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionUnresolved,
					ambiguity: &Ambiguity{
						Candidates: labels,
						Reason:     fmt.Sprintf("'%s' dizininde birden fazla paket bildirimi bulundu; belirsizlik çözülemedi (unresolved).", targetDir),
					},
					rationale: fmt.Sprintf(
						"CALLS: '%s' için '%s' dizininde birden fazla aday paket bulundu (unresolved).",
						text, targetDir,
					),
				}
			}
		}
		// go.mod eşleşti ama hedef dizin analiz setinde yok (analiz dışı modül alt paketi).
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionHeuristic,
			ambiguity: &Ambiguity{
				Candidates: []string{text},
				Reason: fmt.Sprintf(
					"import yolu '%s' analiz seti dışındaki '%s' dizinine çözülüyor (heuristic).",
					imp.importPath, targetDir,
				),
			},
			rationale: fmt.Sprintf(
				"CALLS: %s → %s; analiz seti dışı import yolu, UnknownExternal üzerinde temsil edilir (heuristic).",
				fi.qname, text,
			),
		}
	}

	// Caller dosyası bir go.mod kapsamındaysa ve import hiçbir go.mod modülüne
	// uymuyorsa dış (stdlib/third-party) pakettir — yerel dizin basename'iyle
	// yanlış eşleştirme yapılmaz.
	if fileHasGoverningGoMod(actx.modRoots, fi.file.dir) {
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionHeuristic,
			ambiguity: &Ambiguity{
				Candidates: []string{text},
				Reason: fmt.Sprintf(
					"analiz seti dışı package çağrısı ('%s'); go.mod modül yoluyla eşleşmediğinden UnknownExternal üzerinde temsil edilir (heuristic).",
					imp.importPath,
				),
			},
			rationale: fmt.Sprintf(
				"CALLS: %s → %s; analiz seti dışı package çağrısı, çağrı metni UnknownExternal üzerinde temsil edilir (heuristic).",
				fi.qname, text,
			),
		}
	}

	// 2) go.mod olmadan workspace paket eşleştirmesi — ASLA verified üretilmez!
	//    (a) Önce dizin yolu son-ek eşleşmesi (".../a/util" → "a/util").
	var suffixPkgs []pkgKey
	cleanedImport := strings.TrimRight(imp.importPath, "/")
	for _, pk := range actx.importablePkgs {
		if pk.dir == "." {
			continue
		}
		if cleanedImport == pk.dir || strings.HasSuffix(cleanedImport, "/"+pk.dir) {
			if !imp.aliased && pk.name != imp.localName && path.Base(pk.dir) != imp.localName {
				continue
			}
			suffixPkgs = append(suffixPkgs, pk)
		}
	}

	matchedPkgs := suffixPkgs
	matchedBySuffix := len(suffixPkgs) > 0

	//    (b) Son-ek eşleşmesi yoksa paket adı / basename eşleşmesi.
	if len(matchedPkgs) == 0 {
		seen := map[pkgKey]bool{}
		addByName := func(name string) {
			for _, pk := range actx.importablePkgsByName[name] {
				if !seen[pk] {
					seen[pk] = true
					matchedPkgs = append(matchedPkgs, pk)
				}
			}
		}
		if !imp.aliased {
			addByName(imp.localName)
		} else {
			base := path.Base(cleanedImport)
			addByName(base)
		}
		sort.Slice(matchedPkgs, func(i, j int) bool {
			if matchedPkgs[i].dir != matchedPkgs[j].dir {
				return matchedPkgs[i].dir < matchedPkgs[j].dir
			}
			return matchedPkgs[i].name < matchedPkgs[j].name
		})
	}

	if len(matchedPkgs) == 1 {
		pk := matchedPkgs[0]
		if callee, ok := actx.pkgFuncs[pk][selName]; ok && callee.recv == "" {
			matchKind := "paket adı"
			if matchedBySuffix {
				matchKind = "dizin son-eki"
			}
			return &callTarget{
				ref:        NodeRef{Kind: "Function", QualifiedName: callee.qname, RelativePath: callee.file.relativePath},
				resolution: ResolutionHeuristic,
				ambiguity: &Ambiguity{
					Candidates: []string{callee.qname},
					Reason: fmt.Sprintf(
						"package-qualified çağrı go.mod olmadan %s kuralıyla '%s' (%s) paketine eşlendi; go/types ve go.mod doğrulaması yok (heuristic).",
						matchKind, pk.name, pk.dir,
					),
				},
				rationale: fmt.Sprintf(
					"CALLS: %s → %s; package-qualified çağrı go.mod olmadan %s kuralıyla analiz setindeki '%s' (%s) paketine eşlendi (heuristic).",
					fi.qname, callee.qname, matchKind, pk.name, pk.dir,
				),
			}
		}
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' analiz setindeki '%s' (%s) paketinde tanımlı değil; uydurma hedef üretilmedi (unresolved).",
				text, pk.name, pk.dir,
			),
		}
	}

	if len(matchedPkgs) > 1 {
		var callees []*funcInfo
		for _, pk := range matchedPkgs {
			if callee, ok := actx.pkgFuncs[pk][selName]; ok && callee.recv == "" {
				callees = append(callees, callee)
			}
		}
		if len(callees) > 1 {
			labels := formatCandidateLabels(callees)
			return &callTarget{
				ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
				resolution: ResolutionUnresolved,
				ambiguity: &Ambiguity{
					Candidates: labels,
					Reason: fmt.Sprintf(
						"import yolu '%s' go.mod olmadan birden fazla workspace diziniyle eşleşti; belirsizlik çözülemedi (unresolved).",
						imp.importPath,
					),
				},
				rationale: fmt.Sprintf(
					"CALLS: '%s' go.mod olmadan birden fazla aday paketle eşleşti (%d aday); uydurma hedef üretilmedi (unresolved).",
					text, len(labels),
				),
			}
		}
		if len(callees) == 1 {
			only := callees[0]
			dirCandidates := make([]string, 0, len(matchedPkgs))
			for _, pk := range matchedPkgs {
				dirCandidates = append(dirCandidates, fmt.Sprintf("%s.%s (%s)", pk.name, selName, pk.dir))
			}
			sortStrings(dirCandidates)
			return &callTarget{
				ref:        NodeRef{Kind: "Function", QualifiedName: only.qname, RelativePath: only.file.relativePath},
				resolution: ResolutionHeuristic,
				ambiguity: &Ambiguity{
					Candidates: dirCandidates,
					Reason: fmt.Sprintf(
						"import yolu '%s' go.mod olmadan birden fazla dizinle eşleşti; '%s' yalnızca tek dizinde tanımlı olduğu için heuristic olarak bağlandı.",
						imp.importPath, selName,
					),
				},
				rationale: fmt.Sprintf(
					"CALLS: %s → %s; import yolu '%s' go.mod olmadan çoklu dizin içinde tek sembol adayıyla eşlendi (heuristic).",
					fi.qname, only.qname, imp.importPath,
				),
			}
		}
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' aday paketlerin hiçbirinde tanımlı değil; uydurma hedef üretilmedi (unresolved).",
				text,
			),
		}
	}

	// 3) Analiz setinde eşleşen paket yok → dış package (stdlib / third-party) → heuristic + UnknownExternal.
	return &callTarget{
		ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
		resolution: ResolutionHeuristic,
		ambiguity: &Ambiguity{
			Candidates: []string{text},
			Reason: fmt.Sprintf(
				"analiz seti dışı package çağrısı ('%s'); çağrı metni UnknownExternal üzerinde temsil edilir (heuristic).",
				imp.localName,
			),
		},
		rationale: fmt.Sprintf(
			"CALLS: %s → %s; analiz seti dışı package çağrısı, çağrı metni UnknownExternal üzerinde temsil edilir (heuristic).",
			fi.qname, text,
		),
	}
}

// classifyExpr — Fun ifadesini resolution tablosuna göre çözer; nil → skip.
func classifyExpr(
	actx *analysisContext,
	fi *funcInfo,
	expr ast.Expr,
) *callTarget {
	switch fun := expr.(type) {
	case *ast.Ident:
		if goBuiltins[fun.Name] {
			return nil
		}
		if samePkg, ok := actx.pkgFuncs[fi.pkgKey][fun.Name]; ok && samePkg.recv == "" {
			return &callTarget{
				ref:        NodeRef{Kind: "Function", QualifiedName: samePkg.qname, RelativePath: samePkg.file.relativePath},
				resolution: ResolutionVerified,
				rationale: fmt.Sprintf(
					"CALLS: %s → %s; aynı dizindeki '%s' paketi içindeki tanımlı fonksiyon go/ast ile çözümlendi (verified).",
					fi.qname, samePkg.qname, fi.pkg,
				),
			}
		}
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: fun.Name},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' hiçbir tanımlı sembolle eşleşmedi; uydurma hedef üretilmedi (unresolved).",
				fun.Name,
			),
		}
	case *ast.SelectorExpr:
		selName := fun.Sel.Name
		text := exprText(actx.fset, fi.file.content, expr)
		// (a) Doğrudan paket nitelikli çağrı (pkgAlias.Func): import tablosundan çöz.
		if directX, isDirect := fun.X.(*ast.Ident); isDirect {
			if imp, ok := fi.file.imports[directX.Name]; ok {
				return resolveImportedSelectorCall(actx, fi, imp, selName, text)
			}
		}

		// Zincirli ifadelerde (s.repo.FindAll, json.NewEncoder(w).Encode) sol-temel ident'e inilir.
		var x *ast.Ident
		base := ast.Expr(fun.X)
		for base != nil {
			switch v := base.(type) {
			case *ast.Ident:
				x = v
				base = nil
			case *ast.SelectorExpr:
				base = v.X
			case *ast.ParenExpr:
				base = v.X
			case *ast.CallExpr:
				base = v.Fun
			default:
				base = nil
			}
		}
		if x != nil {
			// (c) Zincirli import çağrısı (örn. json.NewEncoder(w).Encode) → heuristic + UnknownExternal.
			if _, ok := fi.file.imports[x.Name]; ok {
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionHeuristic,
					ambiguity: &Ambiguity{
						Candidates: []string{text},
						Reason: fmt.Sprintf(
							"analiz seti dışı package çağrısı ('%s'); çağrı metni UnknownExternal üzerinde temsil edilir (heuristic).",
							x.Name,
						),
					},
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; analiz seti dışı package çağrısı, çağrı metni UnknownExternal üzerinde temsil edilir (heuristic).",
						fi.qname, text,
					),
				}
			}
			// (d) Yerel değişken/parametre alıcısı → metot adı kuralı.
			if candidates := actx.methodsByName[selName]; len(candidates) == 1 {
				only := candidates[0]
				return &callTarget{
					ref:        NodeRef{Kind: "Method", QualifiedName: only.qname, RelativePath: only.file.relativePath},
					resolution: ResolutionHeuristic,
					ambiguity: &Ambiguity{
						Candidates: []string{only.qname},
						Reason:     "benzersiz metot adı kuralı; alıcı tipi go/types olmadan doğrulanamaz (heuristic).",
					},
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; benzersiz metot adı kuralı (heuristic — alıcı tipi go/types olmadan doğrulanamaz).",
						fi.qname, only.qname,
					),
				}
			} else if len(candidates) > 1 {
				names := formatCandidateLabels(candidates)
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionUnresolved,
					ambiguity: &Ambiguity{
						Candidates: names,
						Reason:     "metot adı analiz setinde birden fazla tipte bulundu; belirsizlik çözülemedi (unresolved).",
					},
					rationale: fmt.Sprintf(
						"CALLS: '%s' birden fazla aday metotla eşleşti (%d aday); uydurma hedef üretilmedi (unresolved).",
						text, len(names),
					),
				}
			}
			// (e) Arayüz metodu adı → heuristic + UnknownExternal.
			if ifaceNames := actx.ifaceMethods[selName]; len(ifaceNames) > 0 {
				sorted := append([]string(nil), ifaceNames...)
				sortStrings(sorted)
				candidates := make([]string, 0, len(sorted))
				for _, ifaceQname := range sorted {
					candidates = append(candidates, ifaceQname+"."+selName)
				}
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionHeuristic,
					ambiguity: &Ambiguity{
						Candidates: candidates,
						Reason:     "arayüz metodu adı analiz setinde bulundu; somut gerçekleme go/types olmadan çözülemez (heuristic).",
					},
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; arayüz metodu adı analiz setinde bulundu, somut gerçekleme çözülemez (heuristic).",
						fi.qname, text,
					),
				}
			}
			// (f) Hiç eşleşme yok.
			return &callTarget{
				ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
				resolution: ResolutionUnresolved,
				rationale: fmt.Sprintf(
					"CALLS: '%s' hiçbir tanımlı sembolle eşleşmedi; uydurma hedef üretilmedi (unresolved).",
					text,
				),
			}
		}
		// X ident değil (zincirli çağrı vb.).
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' zincirli ifade çözümlenemedi; uydurma hedef üretilmedi (unresolved).",
				text,
			),
		}
	default:
		// FuncLit çağrısı, generic instantiation vb.
		text := exprText(actx.fset, fi.file.content, expr)
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' bu dilimde çözümlenmeyen ifade kalıbı; uydurma hedef üretilmedi (unresolved).",
				text,
			),
		}
	}
}

func exprText(fset *token.FileSet, content string, e ast.Expr) string {
	start := fset.Position(e.Pos())
	end := fset.Position(e.End())
	if !start.IsValid() || !end.IsValid() || end.Offset < start.Offset || end.Offset > len(content) {
		return ""
	}
	return content[start.Offset:end.Offset]
}

func collectCallExprs(body *ast.BlockStmt) []*ast.CallExpr {
	var calls []*ast.CallExpr
	ast.Inspect(body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			calls = append(calls, call)
		}
		return true
	})
	return calls
}

// --------------------------------------------------------------------
// Kanonik sıralama + evidence yardımcıları
// --------------------------------------------------------------------

func nodeSortKey(n Node) string {
	return n.Kind + "\x00" + n.QualifiedName + "\x00" + n.RelativePath
}

func sortNodes(nodes []Node) {
	sort.Slice(nodes, func(i, j int) bool {
		return nodeSortKey(nodes[i]) < nodeSortKey(nodes[j])
	})
}

func edgeSortKey(e Edge) string {
	return e.Kind + "\x00" + nodeKey(e.From) + "\x00" + nodeKey(e.To)
}

func sortEdges(edges []Edge) {
	sort.Slice(edges, func(i, j int) bool {
		return edgeSortKey(edges[i]) < edgeSortKey(edges[j])
	})
}

func sortEvidence(evidence []Evidence) {
	sort.Slice(evidence, func(i, j int) bool {
		return evidenceKey(evidence[i]) < evidenceKey(evidence[j])
	})
}

func appendEvidenceUnique(base []Evidence, ev Evidence) []Evidence {
	key := evidenceKey(ev)
	for _, existing := range base {
		if evidenceKey(existing) == key {
			return base
		}
	}
	return append(base, ev)
}
