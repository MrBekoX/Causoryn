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
	"crypto/sha256"
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"io"
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
	id         int    // unique per registered import (deterministic; cache key)
	localName  string // yerel ad (alias veya son yol segmenti)
	importPath string // tırnaksız tam import yolu
	aliased    bool   // açık alias verilmişse true
	// Computed once per import, not once per call (the import path is written
	// once in the file but quoted by every call through it).
	pathText   string // boundName(importPath)
	modDir     string // directory the import path resolves to through go.mod
	modMatched bool   // the import path matched a go.mod module path
	modDirText string // boundName(modDir)
}

// newImportSpec resolves an import through the go.mod roots once.
func newImportSpec(id int, localName, importPath string, aliased bool, modRoots []goModRoot) importSpec {
	modDir, modMatched := resolveImportDirByGoMod(modRoots, importPath)
	return importSpec{
		id:         id,
		localName:  localName,
		importPath: importPath,
		aliased:    aliased,
		pathText:   boundName(importPath),
		modDir:     modDir,
		modMatched: modMatched,
		modDirText: boundName(modDir),
	}
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
	pkgNameText  string // boundName(pkgName), quoted by every verified call of the file
	pkgKey       pkgKey
	imports      map[string]importSpec // import local adı → importSpec ("_"/"." hariç)
	importList   []importSpec
	f            *ast.File
	depthFlagged bool
	// spanDigests — digests of the call-expression texts of this file that
	// exceed MaxRenderedTextBytes, keyed by byte range (see prepareSpanDigests).
	spanDigests map[spanKey]string
}

// spanKey — the byte range [start, end) of a source text in its file.
type spanKey struct {
	start int
	end   int
}

// exprSpan — the byte range of e in content.
func exprSpan(fset *token.FileSet, content string, e ast.Expr) (spanKey, bool) {
	start := fset.Position(e.Pos())
	end := fset.Position(e.End())
	if !start.IsValid() || !end.IsValid() || end.Offset < start.Offset || end.Offset > len(content) {
		return spanKey{}, false
	}
	return spanKey{start: start.Offset, end: end.Offset}, true
}

// prepareSpanDigests computes the digests of the given long texts. Texts that
// share a start offset — a call chain a(x)()() or a(x).b().c(), whose callee
// texts are successive prefixes of one span — are hashed in one pass of a
// running SHA-256 instead of once each from the start, so the cost is linear
// in the span instead of quadratic. A text longer than MaxHashedTextBytes gets
// a digest of its file and byte range instead.
func (f *fileCtx) prepareSpanDigests(spans []spanKey) {
	endsByStart := map[int][]int{}
	for _, s := range spans {
		if s.end-s.start <= MaxRenderedTextBytes {
			continue
		}
		if _, done := f.spanDigests[s]; done {
			continue
		}
		endsByStart[s.start] = append(endsByStart[s.start], s.end)
	}
	for start, ends := range endsByStart {
		sort.Ints(ends)
		f.hashSpans(start, ends)
	}
}

// hashSpans records the digests of [start, end) for ascending ends.
func (f *fileCtx) hashSpans(start int, ends []int) {
	if f.spanDigests == nil {
		f.spanDigests = map[spanKey]string{}
	}
	h := sha256.New()
	written := start
	for _, end := range ends {
		key := spanKey{start: start, end: end}
		if _, done := f.spanDigests[key]; done {
			continue
		}
		if end-start > MaxHashedTextBytes {
			f.spanDigests[key] = rangeDigest(f, key)
			continue
		}
		_, _ = io.WriteString(h, f.content[written:end])
		written = end
		f.spanDigests[key] = digestHex12(h.Sum(nil))
	}
}

// rangeDigest — the digest of a text too long to hash, taken over its file
// (path and content hash) and byte range, which identify it exactly.
func rangeDigest(f *fileCtx, key spanKey) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf(
		"go-worker source range\x00%s\x00%s\x00%d\x00%d", f.relativePath, f.hash, key.start, key.end,
	)))
	return digestHex12(sum[:])
}

// spanDigest — the digest of a long text (computed on demand when it was not
// prepared).
func (f *fileCtx) spanDigest(key spanKey) string {
	if digest, ok := f.spanDigests[key]; ok {
		return digest
	}
	f.hashSpans(key.start, []int{key.end})
	return f.spanDigests[key]
}

// sourceText — the source text of e bounded at MaxRenderedTextBytes: a
// longer text becomes its prefix, "...#" and the first 12 hex digits of the
// SHA-256 of the full text (the same form as boundText).
func sourceText(fset *token.FileSet, f *fileCtx, e ast.Expr) string {
	key, ok := exprSpan(fset, f.content, e)
	if !ok {
		return ""
	}
	text := f.content[key.start:key.end]
	if len(text) <= MaxRenderedTextBytes {
		return text
	}
	return cutPrefix(text, MaxRenderedTextBytes) + "...#" + f.spanDigest(key)
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
	importCount := 0

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
					// A parser message can quote a token literal of any length.
					diagnostics = append(diagnostics, Diagnostic{
						RelativePath: sf.RelativePath,
						Code:         "GOPARSE",
						Message:      boundExprText(e.Msg),
						Line:         line,
					})
				}
			} else {
				diagnostics = append(diagnostics, Diagnostic{
					RelativePath: sf.RelativePath,
					Code:         "GOPARSE",
					Message:      boundExprText(err.Error()),
					Line:         0,
				})
			}
		}
		if parsed == nil {
			continue
		}
		ctx.f = parsed
		ctx.pkgName = parsed.Name.Name
		ctx.pkgNameText = boundName(ctx.pkgName)
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
				importCount++
				spec := newImportSpec(importCount, local, pathValue, aliased, modRoots)
				ctx.imports[local] = spec
				ctx.importList = append(ctx.importList, spec)
			}
		}
		for _, decl := range parsed.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				recv := receiverTypeName(d)
				fi := &funcInfo{file: ctx, decl: d, pkg: ctx.pkgName, pkgKey: ctx.pkgKey, name: d.Name.Name, recv: recv}
				// Qualified names are bounded once here; lookups use the raw names.
				if recv != "" {
					fi.qname = boundName(ctx.pkgName + "." + recv + "." + d.Name.Name)
				} else {
					fi.qname = boundName(ctx.pkgName + "." + d.Name.Name)
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
					ti := &typeInfo{file: ctx, spec: ts, pkg: ctx.pkgName, pkgKey: ctx.pkgKey, name: ts.Name.Name, qname: boundName(ctx.pkgName + "." + ts.Name.Name)}
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
			if spec.modMatched {
				if dirPkgs := pkgsByDir[spec.modDir]; len(dirPkgs) == 1 {
					declared := dirPkgs[0].name
					if declared != "" && declared != "_" && declared != "." {
						if _, exists := ctx.imports[declared]; !exists {
							importCount++
							ctx.imports[declared] = newImportSpec(importCount, declared, spec.importPath, false, modRoots)
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

	// 3) Node kümeleri. Every admitted node, edge, evidence record and warning
	//    is charged at its serialized size against MaxResponseBytes; once the
	//    budget is spent nothing more is admitted (edges never dangle).
	sizeBudget := &responseBudget{}
	nodeSet := map[string]Node{}
	addNode := func(n Node) NodeRef {
		ref := NodeRef{Kind: n.Kind, QualifiedName: n.QualifiedName, RelativePath: n.RelativePath}
		key := nodeKey(ref)
		if existing, exists := nodeSet[key]; !exists {
			cost := jsonSize(n) + 1
			if n.Kind == "File" {
				// One File node per file (bounded by MaxFileCount): always admitted.
				sizeBudget.used += cost
			} else if !sizeBudget.charge(cost) {
				return ref
			}
			nodeSet[key] = n
		} else if n.Span != nil {
			existing.Span = widenSpan(existing.Span, n.Span)
			nodeSet[key] = existing
		}
		return ref
	}
	// nodeSpan — 1-based lines of a declaration's Pos() and End() (the doc
	// comment is outside the declaration node, so it is not included).
	nodeSpan := func(from, to token.Pos) *NodeSpan {
		return &NodeSpan{StartLine: fset.Position(from).Line, EndLine: fset.Position(to).Line}
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
		return addNode(Node{Kind: kind, QualifiedName: fi.qname, Language: "go", RelativePath: fi.file.relativePath, Span: nodeSpan(fi.decl.Pos(), fi.decl.End()), Attributes: map[string]any{}})
	}
	typeRef := func(ti *typeInfo) NodeRef {
		return addNode(Node{Kind: ti.kind, QualifiedName: ti.qname, Language: "go", RelativePath: ti.file.relativePath, Span: nodeSpan(ti.spec.Pos(), ti.spec.End()), Attributes: map[string]any{}})
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

	// 4) Kenar toplayıcı (dedupe + evidence birleştirme). Each edge keeps the
	//    set of its evidence keys, so merging is linear: every evidence record
	//    is marshalled once instead of re-marshalling the edge's whole list.
	edgeSet := map[string]int{}
	var edges []Edge
	var edgeEvidenceKeys []map[string]struct{}
	addEdge := func(e Edge) {
		key := edgeKey(e)
		if idx, ok := edgeSet[key]; ok {
			seen := edgeEvidenceKeys[idx]
			for _, ev := range e.Evidence {
				evKey := evidenceKey(ev)
				if _, duplicate := seen[evKey]; duplicate {
					continue
				}
				if !sizeBudget.charge(evidenceCost(evKey)) {
					return // the edge keeps the evidence it already has
				}
				seen[evKey] = struct{}{}
				edges[idx].Evidence = append(edges[idx].Evidence, ev)
			}
			return
		}
		if sizeBudget.exceeded {
			return
		}
		ensureNodeRef(e.From)
		ensureNodeRef(e.To)
		if _, ok := nodeSet[nodeKey(e.From)]; !ok {
			return // endpoint not admitted: no dangling edge
		}
		if _, ok := nodeSet[nodeKey(e.To)]; !ok {
			return
		}
		cost := jsonSize(Edge{Kind: e.Kind, From: e.From, To: e.To, Resolution: e.Resolution, Ambiguity: e.Ambiguity}) + 1
		seen := make(map[string]struct{}, len(e.Evidence))
		for _, ev := range e.Evidence {
			evKey := evidenceKey(ev)
			seen[evKey] = struct{}{}
			cost += evidenceCost(evKey)
		}
		if !sizeBudget.charge(cost) {
			return
		}
		edgeSet[key] = len(edges)
		edges = append(edges, e)
		edgeEvidenceKeys = append(edgeEvidenceKeys, seen)
	}
	warningsSuppressed := false
	addWarning := func(message string) {
		if !sizeBudget.charge(jsonSize(message) + 1) {
			if !warningsSuppressed {
				warningsSuppressed = true
				warnings = append(warnings, "further warnings were not emitted: the response size budget was reached")
			}
			return
		}
		warnings = append(warnings, message)
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
					"CONTAINS: %s contains the '%s' declaration (go/ast declaration range).",
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
							"CONTAINS: %s contains the '%s' method (go/ast receiver match).",
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
					"CONTAINS: %s contains the '%s' declaration (go/ast type spec range).",
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
			Message:      fmt.Sprintf("AST traversal depth %d exceeded; deep bodies were not included in call extraction", MaxAstDepth),
			Line:         0,
		}
		diagnostics = append(diagnostics, diagnostic)
		addWarning(fmt.Sprintf("%s: bodies exceeding the AST depth limit were skipped (%s)", AnalyzerID, fctx.relativePath))
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
		addWarning:           addWarning,
		declSpan:             declSpan,
	}
	for _, fi := range funcs {
		if sizeBudget.exceeded {
			break // nothing more can be admitted
		}
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
		matches := make([]*routeMatch, len(calls))
		spans := make([]spanKey, 0, len(calls))
		for i, call := range calls {
			matches[i] = matchRoute(call)
			if key, ok := quotedTextSpan(fset, fi.file.content, call, matches[i]); ok {
				spans = append(spans, key)
			}
		}
		fi.file.prepareSpanDigests(spans)
		for i, call := range calls {
			if sizeBudget.exceeded {
				break
			}
			if matches[i] != nil {
				handleRoute(actx, fi, matches[i], call)
				continue
			}
			resolveAndAddCallEdge(actx, fi, call)
		}
	}
	if sizeBudget.exceeded {
		diagnostics = append(diagnostics, Diagnostic{
			RelativePath: "",
			Code:         "RESPONSE_TRUNCATED",
			Message: fmt.Sprintf(
				"response size budget exceeded (%d bytes of nodes, edges, evidence and warnings); further nodes, edges, evidence and warnings were not emitted (no dangling edges)",
				MaxResponseBytes,
			),
			Line: 0,
		})
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
				"response node budget (%d) exceeded; %d nodes emitted, %d edges with unemitted endpoints dropped (no dangling edges)",
				budget, budget, droppedEdges,
			),
			Line: 0,
		})
		nodes = nodes[:budget]
	}
	sortEdges(edges)

	evidenceSet := map[string]bool{}
	var keyed []keyedEvidence
	for _, e := range edges {
		for _, ev := range e.Evidence {
			key := evidenceKey(ev)
			if !evidenceSet[key] {
				evidenceSet[key] = true
				keyed = append(keyed, keyedEvidence{key: key, evidence: ev})
			}
		}
	}
	evidence := sortedEvidence(keyed)

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

// methodCandidateList — the capped label list of every method named name. It
// is built once per name (methodsByName is fixed during the call pass) and
// shared by every call of that name.
func (actx *analysisContext) methodCandidateList(name string) candidateList {
	if list, ok := actx.methodCandidates[name]; ok {
		return list
	}
	list := capCandidates(formatCandidateLabels(actx.methodsByName[name]))
	if actx.methodCandidates == nil {
		actx.methodCandidates = map[string]candidateList{}
	}
	actx.methodCandidates[name] = list
	return list
}

// ifaceCandidateList — the capped "<Interface>.<method>" list of every
// interface that declares a method named name, built once per name. The
// interface names are sorted before the method suffix is added.
func (actx *analysisContext) ifaceCandidateList(name string) candidateList {
	if list, ok := actx.ifaceCandidates[name]; ok {
		return list
	}
	sorted := append([]string(nil), actx.ifaceMethods[name]...)
	sortStrings(sorted)
	member := "." + boundName(name)
	candidates := make([]string, 0, len(sorted))
	for _, ifaceQname := range sorted {
		candidates = append(candidates, ifaceQname+member)
	}
	list := capCandidates(candidates)
	if actx.ifaceCandidates == nil {
		actx.ifaceCandidates = map[string]candidateList{}
	}
	actx.ifaceCandidates[name] = list
	return list
}

// importMatch — the workspace packages an import matches without go.mod:
// directory suffix first, then package name / basename.
type importMatch struct {
	pkgs     []pkgKey
	bySuffix bool
}

// matchImport computes the no-go.mod package match of an import once.
func (actx *analysisContext) matchImport(imp importSpec) importMatch {
	if match, ok := actx.importMatches[imp.id]; ok {
		return match
	}
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

	match := importMatch{pkgs: matchedPkgs, bySuffix: matchedBySuffix}
	if actx.importMatches == nil {
		actx.importMatches = map[int]importMatch{}
	}
	actx.importMatches[imp.id] = match
	return match
}

// pkgCallees — the packages of a match that define a top-level func.
type pkgCallees struct {
	count     int           // packages that define the func
	only      *funcInfo     // the callee when count == 1
	labels    candidateList // callee labels when count > 1
	dirLabels candidateList // "<pkg>.<func> (<dir>)" of every package when count == 1
}

// calleeKey — cache key of pkgCallees: the import (by id) whose packages are
// searched (its go.mod directory, or its no-go.mod match), plus the selector.
type calleeKey struct {
	goMod    bool
	importID int
	sel      string
}

// calleesIn finds the packages among pkgs that define sel, once per key.
func (actx *analysisContext) calleesIn(key calleeKey, pkgs []pkgKey) pkgCallees {
	if callees, ok := actx.pkgCallees[key]; ok {
		return callees
	}
	var found []*funcInfo
	for _, pk := range pkgs {
		if callee, ok := actx.pkgFuncs[pk][key.sel]; ok && callee.recv == "" {
			found = append(found, callee)
		}
	}
	callees := pkgCallees{count: len(found)}
	switch {
	case len(found) > 1:
		callees.labels = capCandidates(formatCandidateLabels(found))
	case len(found) == 1:
		callees.only = found[0]
		dirCandidates := make([]string, 0, len(pkgs))
		for _, pk := range pkgs {
			dirCandidates = append(dirCandidates, boundName(fmt.Sprintf("%s.%s (%s)", pk.name, key.sel, pk.dir)))
		}
		sortStrings(dirCandidates)
		callees.dirLabels = capCandidates(dirCandidates)
	}
	if actx.pkgCallees == nil {
		actx.pkgCallees = map[calleeKey]pkgCallees{}
	}
	actx.pkgCallees[key] = callees
	return callees
}

// pkgLabel — the bounded name and directory of a package, for rationales.
type pkgLabel struct {
	name string
	dir  string
}

func (actx *analysisContext) pkgText(pk pkgKey) pkgLabel {
	if label, ok := actx.pkgTexts[pk]; ok {
		return label
	}
	label := pkgLabel{name: boundName(pk.name), dir: boundName(pk.dir)}
	if actx.pkgTexts == nil {
		actx.pkgTexts = map[pkgKey]pkgLabel{}
	}
	actx.pkgTexts[pk] = label
	return label
}

func resolveImportedSelectorCall(
	actx *analysisContext,
	fi *funcInfo,
	imp importSpec,
	selName string,
	text string,
) *callTarget {
	// 1) go.mod tam modül yolu eşleşmesi → verified!
	if imp.modMatched {
		targetDir := imp.modDir
		dirPkgs := actx.pkgsByDir[targetDir]
		if len(dirPkgs) == 1 {
			targetPkg := dirPkgs[0]
			if callee, ok := actx.pkgFuncs[targetPkg][selName]; ok && callee.recv == "" {
				return &callTarget{
					ref:        NodeRef{Kind: "Function", QualifiedName: callee.qname, RelativePath: callee.file.relativePath},
					resolution: ResolutionVerified,
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; import path '%s' resolved exactly to directory '%s' via go.mod (verified).",
						fi.qname, callee.qname, imp.pathText, imp.modDirText,
					),
				}
			}
			return &callTarget{
				ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
				resolution: ResolutionUnresolved,
				rationale: fmt.Sprintf(
					"CALLS: '%s' is not defined in package '%s' (%s) resolved via go.mod; no fabricated target was produced (unresolved).",
					text, actx.pkgText(targetPkg).name, imp.modDirText,
				),
			}
		}
		if len(dirPkgs) > 1 {
			callees := actx.calleesIn(calleeKey{goMod: true, importID: imp.id, sel: selName}, dirPkgs)
			if callees.count > 1 {
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionUnresolved,
					ambiguity: callees.labels.ambiguity(fmt.Sprintf(
						"multiple package declarations found in directory '%s'; the ambiguity could not be resolved (unresolved).",
						imp.modDirText,
					)),
					rationale: fmt.Sprintf(
						"CALLS: '%s' has multiple candidate packages in directory '%s' (unresolved).",
						text, imp.modDirText,
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
					"import path '%s' resolves to directory '%s' outside the analysis set (heuristic).",
					imp.pathText, imp.modDirText,
				),
			},
			rationale: fmt.Sprintf(
				"CALLS: %s → %s; import path outside the analysis set, represented on UnknownExternal (heuristic).",
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
					"package call outside the analysis set ('%s'); it does not match the go.mod module path, so it is represented on UnknownExternal (heuristic).",
					imp.pathText,
				),
			},
			rationale: fmt.Sprintf(
				"CALLS: %s → %s; package call outside the analysis set, the call text is represented on UnknownExternal (heuristic).",
				fi.qname, text,
			),
		}
	}

	// 2) go.mod olmadan workspace paket eşleştirmesi — ASLA verified üretilmez!
	match := actx.matchImport(imp)
	matchedPkgs := match.pkgs

	if len(matchedPkgs) == 1 {
		pk := matchedPkgs[0]
		label := actx.pkgText(pk)
		if callee, ok := actx.pkgFuncs[pk][selName]; ok && callee.recv == "" {
			matchKind := "package name"
			if match.bySuffix {
				matchKind = "directory suffix"
			}
			return &callTarget{
				ref:        NodeRef{Kind: "Function", QualifiedName: callee.qname, RelativePath: callee.file.relativePath},
				resolution: ResolutionHeuristic,
				ambiguity: &Ambiguity{
					Candidates: []string{callee.qname},
					Reason: fmt.Sprintf(
						"package-qualified call matched by the %s rule without go.mod to package '%s' (%s); no go/types or go.mod verification (heuristic).",
						matchKind, label.name, label.dir,
					),
				},
				rationale: fmt.Sprintf(
					"CALLS: %s → %s; package-qualified call matched by the %s rule without go.mod to package '%s' (%s) in the analysis set (heuristic).",
					fi.qname, callee.qname, matchKind, label.name, label.dir,
				),
			}
		}
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' is not defined in package '%s' (%s) in the analysis set; no fabricated target was produced (unresolved).",
				text, label.name, label.dir,
			),
		}
	}

	if len(matchedPkgs) > 1 {
		callees := actx.calleesIn(calleeKey{importID: imp.id, sel: selName}, matchedPkgs)
		if callees.count > 1 {
			return &callTarget{
				ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
				resolution: ResolutionUnresolved,
				ambiguity: callees.labels.ambiguity(fmt.Sprintf(
					"import path '%s' matched multiple workspace directories without go.mod; the ambiguity could not be resolved (unresolved).",
					imp.pathText,
				)),
				rationale: fmt.Sprintf(
					"CALLS: '%s' matched multiple candidate packages without go.mod (%d candidates); no fabricated target was produced (unresolved).",
					text, callees.labels.total,
				),
			}
		}
		if callees.count == 1 {
			only := callees.only
			return &callTarget{
				ref:        NodeRef{Kind: "Function", QualifiedName: only.qname, RelativePath: only.file.relativePath},
				resolution: ResolutionHeuristic,
				ambiguity: callees.dirLabels.ambiguity(fmt.Sprintf(
					"import path '%s' matched multiple directories without go.mod; '%s' is defined in only one of them, so it was linked heuristically.",
					imp.pathText, boundName(selName),
				)),
				rationale: fmt.Sprintf(
					"CALLS: %s → %s; import path '%s' matched a single symbol candidate across multiple directories without go.mod (heuristic).",
					fi.qname, only.qname, imp.pathText,
				),
			}
		}
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' is not defined in any candidate package; no fabricated target was produced (unresolved).",
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
				"package call outside the analysis set ('%s'); the call text is represented on UnknownExternal (heuristic).",
				boundName(imp.localName),
			),
		},
		rationale: fmt.Sprintf(
			"CALLS: %s → %s; package call outside the analysis set, the call text is represented on UnknownExternal (heuristic).",
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
					"CALLS: %s → %s; resolved with go/ast to a function defined in package '%s' in the same directory (verified).",
					fi.qname, samePkg.qname, fi.file.pkgNameText,
				),
			}
		}
		name := boundExprText(fun.Name)
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: name},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' did not match any defined symbol; no fabricated target was produced (unresolved).",
				name,
			),
		}
	case *ast.SelectorExpr:
		selName := fun.Sel.Name
		// Call text is bounded before it is used as a name or quoted anywhere.
		text := sourceText(actx.fset, fi.file, expr)
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
							"package call outside the analysis set ('%s'); the call text is represented on UnknownExternal (heuristic).",
							boundName(x.Name),
						),
					},
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; package call outside the analysis set, the call text is represented on UnknownExternal (heuristic).",
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
						Reason:     "unique method name rule; the receiver type cannot be verified without go/types (heuristic).",
					},
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; unique method name rule (heuristic — the receiver type cannot be verified without go/types).",
						fi.qname, only.qname,
					),
				}
			} else if len(candidates) > 1 {
				names := actx.methodCandidateList(selName)
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionUnresolved,
					ambiguity:  names.ambiguity("the method name was found on multiple types in the analysis set; the ambiguity could not be resolved (unresolved)."),
					rationale: fmt.Sprintf(
						"CALLS: '%s' matched multiple candidate methods (%d candidates); no fabricated target was produced (unresolved).",
						text, names.total,
					),
				}
			}
			// (e) Arayüz metodu adı → heuristic + UnknownExternal.
			if len(actx.ifaceMethods[selName]) > 0 {
				candidates := actx.ifaceCandidateList(selName)
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionHeuristic,
					ambiguity:  candidates.ambiguity("the interface method name was found in the analysis set; the concrete implementation cannot be resolved without go/types (heuristic)."),
					rationale: fmt.Sprintf(
						"CALLS: %s → %s; the interface method name was found in the analysis set, the concrete implementation cannot be resolved (heuristic).",
						fi.qname, text,
					),
				}
			}
			// (f) Hiç eşleşme yok.
			return &callTarget{
				ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
				resolution: ResolutionUnresolved,
				rationale: fmt.Sprintf(
					"CALLS: '%s' did not match any defined symbol; no fabricated target was produced (unresolved).",
					text,
				),
			}
		}
		// X ident değil (zincirli çağrı vb.).
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' chained expression could not be resolved; no fabricated target was produced (unresolved).",
				text,
			),
		}
	default:
		// FuncLit çağrısı, generic instantiation vb.
		text := sourceText(actx.fset, fi.file, expr)
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"CALLS: '%s' uses an expression pattern that is not resolved yet; no fabricated target was produced (unresolved).",
				text,
			),
		}
	}
}

// quotedTextSpan — the byte range of the source text that resolving the call
// can quote: the callee expression, or for a route registration its handler
// expression (identifiers and inline func literal handlers quote none).
func quotedTextSpan(fset *token.FileSet, content string, call *ast.CallExpr, match *routeMatch) (spanKey, bool) {
	target := call.Fun
	if match != nil {
		if _, isLit := match.handler.(*ast.FuncLit); isLit {
			return spanKey{}, false
		}
		target = match.handler
	}
	if _, isIdent := target.(*ast.Ident); isIdent {
		return spanKey{}, false
	}
	return exprSpan(fset, content, target)
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
