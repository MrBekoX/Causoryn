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

type fileCtx struct {
	relativePath string
	content      string
	hash         string
	pkgName      string
	imports      map[string]bool // import local adları ("_"/"." hariç)
	f            *ast.File
	depthFlagged bool
}

type funcInfo struct {
	file  *fileCtx
	decl  *ast.FuncDecl
	pkg   string
	name  string
	recv  string // "" → top-level func; değilse alıcı tip adı
	qname string
}

type typeInfo struct {
	file  *fileCtx
	spec  *ast.TypeSpec
	pkg   string
	name  string
	qname string
	kind  string // Class | Interface | Type
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

// Analyze — verilen dosyalar (relativePath sıralı) üzerinden graph üretir.
// maxNodes ≤ 0 → MaxResponseNodes uygulanır.
func Analyze(files []SourceFile, maxNodes int) Result {
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

	fset := token.NewFileSet()
	var warnings []string
	var diagnostics []Diagnostic

	var fileCtxs []*fileCtx
	var funcs []*funcInfo
	var types []*typeInfo
	pkgCount := map[string]int{}

	// 1) Parse + declaration toplama (dosya sıralı, belge sıralı).
	for _, sf := range files {
		ctx := &fileCtx{
			relativePath: sf.RelativePath,
			content:      sf.Content,
			hash:         sf.SourceHash,
			imports:      map[string]bool{},
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
		pkgCount[parsed.Name.Name]++
		for _, imp := range parsed.Imports {
			pathValue, uerr := strconv.Unquote(imp.Path.Value)
			if uerr != nil {
				continue
			}
			local := ""
			if imp.Name != nil {
				local = imp.Name.Name
			}
			if local == "" {
				local = pathValue
				if idx := strings.LastIndex(local, "/"); idx >= 0 {
					local = local[idx+1:]
				}
			}
			if local != "_" && local != "." && local != "" {
				ctx.imports[local] = true
			}
		}
		for _, decl := range parsed.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				recv := receiverTypeName(d)
				fi := &funcInfo{file: ctx, decl: d, pkg: ctx.pkgName, name: d.Name.Name, recv: recv}
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
					ti := &typeInfo{file: ctx, spec: ts, pkg: ctx.pkgName, name: ts.Name.Name, qname: ctx.pkgName + "." + ts.Name.Name}
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

	// 2) İndeksler.
	pkgFuncs := map[string]map[string]*funcInfo{} // package → top-level func adı
	methodsByName := map[string][]*funcInfo{}     // metot adı → adaylar (belge sıralı)
	ifaceMethods := map[string][]string{}         // arayüz metodu adı → arayüz qname'leri
	typeIndex := map[string]*typeInfo{}           // pkg\x00name → typeInfo
	for _, ti := range types {
		typeIndex[ti.pkg+"\x00"+ti.name] = ti
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
			m := pkgFuncs[fi.pkg]
			if m == nil {
				m = map[string]*funcInfo{}
				pkgFuncs[fi.pkg] = m
			}
			m[fi.name] = fi
		} else {
			methodsByName[fi.name] = append(methodsByName[fi.name], fi)
		}
	}
	uniquePkg := func(name string) bool { return pkgCount[name] == 1 }

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
			if ti, ok := typeIndex[fi.pkg+"\x00"+fi.recv]; ok {
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
		fset:          fset,
		pkgFuncs:      pkgFuncs,
		uniquePkg:     uniquePkg,
		methodsByName: methodsByName,
		ifaceMethods:  ifaceMethods,
		addNode:       addNode,
		addEdge:       addEdge,
		warnings:      &warnings,
		declSpan:      declSpan,
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
	target := classifyExpr(fi, call.Fun, actx.fset, actx.pkgFuncs, actx.uniquePkg, actx.methodsByName, actx.ifaceMethods)
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

// classifyExpr — Fun ifadesini resolution tablosuna göre çözer; nil → skip.
func classifyExpr(
	fi *funcInfo,
	expr ast.Expr,
	fset *token.FileSet,
	pkgFuncs map[string]map[string]*funcInfo,
	uniquePkg func(string) bool,
	methodsByName map[string][]*funcInfo,
	ifaceMethods map[string][]string,
) *callTarget {
	switch fun := expr.(type) {
	case *ast.Ident:
		if goBuiltins[fun.Name] {
			return nil
		}
		if samePkg, ok := pkgFuncs[fi.pkg][fun.Name]; ok && samePkg.recv == "" {
			return &callTarget{
				ref:        NodeRef{Kind: "Function", QualifiedName: samePkg.qname, RelativePath: samePkg.file.relativePath},
				resolution: ResolutionVerified,
				rationale: fmt.Sprintf(
					"CALLS: %s → %s; aynı package içindeki tanımlı fonksiyon go/ast ile çözümlendi (verified).",
					fi.qname, samePkg.qname,
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
		text := exprText(fset, fi.file.content, expr)
		// Zincirli ifadelerde (s.repo.FindAll) sol-temel ident'e inilir:
		// package/import kontrolü TEMELE, metot adı kuralı dış Sel'e bakar.
		// Böylece struct alanı üzerinden erişilen bağımlılık metotları
		// (field.Method) benzersiz-ad kuralıyla çözümlenebilir.
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
			// (a) Analiz setindeki package (unique clause adı) + declared func.
			if uniquePkg(x.Name) {
				if callee, ok := pkgFuncs[x.Name][selName]; ok && callee.recv == "" {
					return &callTarget{
						ref:        NodeRef{Kind: "Function", QualifiedName: callee.qname, RelativePath: callee.file.relativePath},
						resolution: ResolutionHeuristic,
						ambiguity: &Ambiguity{
							Candidates: []string{callee.qname},
							Reason: fmt.Sprintf(
								"package-qualified çağrı ad kuralıyla analiz setindeki %s package'ına eşlendi; go/types semantik çözümleme yok (heuristic).",
								x.Name,
							),
						},
						rationale: fmt.Sprintf(
							"CALLS: %s → %s; package-qualified çağrı ad kuralıyla analiz setindeki %s package'ına eşlendi (heuristic — go/types yok).",
							fi.qname, callee.qname, x.Name,
						),
					}
				}
				// (b) Setteki package ama bildirim yok → çözümsüz (uydurma yok).
				return &callTarget{
					ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: text},
					resolution: ResolutionUnresolved,
					rationale: fmt.Sprintf(
						"CALLS: '%s' analiz setindeki %s package'ında tanımlı değil; uydurma hedef üretilmedi (unresolved).",
						text, x.Name,
					),
				}
			}
			// (c) Import local adı (analiz seti dışı package) → heuristic.
			if fi.file.imports[x.Name] {
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
			if candidates := methodsByName[selName]; len(candidates) == 1 {
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
				names := make([]string, 0, len(candidates))
				for _, candidate := range candidates {
					names = append(names, candidate.qname)
				}
				sortStrings(names)
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
			if ifaceNames := ifaceMethods[selName]; len(ifaceNames) > 0 {
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
		text := exprText(fset, fi.file.content, expr)
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
