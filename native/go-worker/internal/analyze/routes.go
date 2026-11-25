// routes.go — L3 route kayıt tespiti (M1-Go).
//
// Kalıp katmanı (documented heuristic): http.HandleFunc/Handle ve
// gin/echo/chi benzeri kayıt metot adları (get/post/put/delete/patch/
// head/options — büyük/küçük harf duyarsız; chi Get gibi). Yanıltıcı
// pozitifleri kırmak için iki koruma şarttır:
//  1. ilk argüman string literal VE "/" önekli path,
//  2. en az iki argüman (path + handler; tek-argümanlı map delete vb. elenir).
//
// Tanınan kayıt çağrıları CALLS ÜRETMEZ — semantikleri Endpoint +
// ROUTES_TO ile tam temsil edilir (PROTOCOL.md). Handle/HandleFunc HTTP
// fiili taşımadığından Endpoint metodu "*" olur.
//
// Handler çözümü: named func (aynı package) → verified; selector →
// resolution tablosu (heuristic/unresolved); func literal → inline anonim
// handler: Endpoint KORUNUR, kenar ÜRETİLMEZ + uyarı (Roslyn worker
// unsupportedConstructs paraleli).
package analyze

import (
	"fmt"
	"go/ast"
	"go/token"
	"strconv"
	"strings"
)

type routeMatch struct {
	verb    string
	path    string
	handler ast.Expr // Args[1]
}

// analysisContext — tek Analyze koşumunun paylaşılan indeksleri ve
// çıktı toplayıcıları (parametre listesi patlamasın).
type analysisContext struct {
	fset                 *token.FileSet
	modRoots             []goModRoot
	pkgFuncs             map[pkgKey]map[string]*funcInfo
	pkgsByDir            map[string][]pkgKey
	importablePkgs       []pkgKey
	importablePkgsByName map[string][]pkgKey
	methodsByName        map[string][]*funcInfo
	ifaceMethods         map[string][]string
	addNode              func(Node) NodeRef
	addEdge              func(Edge)
	warnings             *[]string
	declSpan             func(*fileCtx, token.Pos, token.Pos) *Span
}

// matchRoute — kayıt çağrısı kalıbını tanır; eşleşmezse nil.
func matchRoute(call *ast.CallExpr) *routeMatch {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return nil
	}
	if _, ok := sel.X.(*ast.Ident); !ok {
		return nil
	}
	verb := ""
	switch strings.ToLower(sel.Sel.Name) {
	case "handle", "handlefunc":
		verb = "*"
	case "get":
		verb = "GET"
	case "post":
		verb = "POST"
	case "put":
		verb = "PUT"
	case "delete":
		verb = "DELETE"
	case "patch":
		verb = "PATCH"
	case "head":
		verb = "HEAD"
	case "options":
		verb = "OPTIONS"
	default:
		return nil
	}
	if len(call.Args) < 2 {
		return nil
	}
	lit, ok := call.Args[0].(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return nil
	}
	path, uerr := strconv.Unquote(lit.Value)
	if uerr != nil || !strings.HasPrefix(path, "/") {
		return nil
	}
	return &routeMatch{verb: verb, path: path, handler: call.Args[1]}
}

// handleRoute — Endpoint node + (inline değilse) ROUTES_TO kenarı üretir.
func handleRoute(ctx *analysisContext, fi *funcInfo, match *routeMatch, call *ast.CallExpr) {
	line := ctx.declSpan(fi.file, call.Pos(), call.End()).StartLine
	endpointRef := ctx.addNode(Node{
		Kind:          "Endpoint",
		QualifiedName: match.verb + " " + match.path,
		Language:      "go",
		RelativePath:  fi.file.relativePath,
		Attributes:    map[string]any{"method": match.verb, "path": match.path},
	})

	if _, isLit := match.handler.(*ast.FuncLit); isLit {
		*ctx.warnings = append(*ctx.warnings, fmt.Sprintf(
			"%s: inline anonymous route handler '%s %s' (%s:%d) — the Endpoint is kept, no ROUTES_TO is produced",
			AnalyzerID, match.verb, match.path, fi.file.relativePath, line,
		))
		return
	}

	target := classifyHandler(ctx, fi, match.handler)
	if target == nil {
		*ctx.warnings = append(*ctx.warnings, fmt.Sprintf(
			"%s: the route handler for '%s %s' could not be resolved (%s:%d)",
			AnalyzerID, match.verb, match.path, fi.file.relativePath, line,
		))
		return
	}

	resolutionText := map[string]string{
		ResolutionVerified:   "verified",
		ResolutionHeuristic:  "heuristic",
		ResolutionUnresolved: "unresolved",
	}[target.resolution]

	ctx.addEdge(Edge{
		Kind:       EdgeRoutesTo,
		From:       endpointRef,
		To:         target.ref,
		Resolution: target.resolution,
		Evidence: []Evidence{{
			Kind:            EvidenceKindRouteReg,
			Span:            ctx.declSpan(fi.file, call.Pos(), call.End()),
			AnalyzerID:      AnalyzerID,
			AnalyzerVersion: AnalyzerVersion,
			Rationale: fmt.Sprintf(
				"ROUTES_TO: route registration call '%s %s' (http.HandleFunc / gin-echo-chi pattern) resolved to handler %s (%s).",
				match.verb, match.path, target.ref.QualifiedName, resolutionText,
			),
		}},
		Ambiguity: target.ambiguity,
	})
}

// classifyHandler — route handler ifadesi için resolution tablosu
// (classifyExpr ile aynı tablo; rationale ROUTES_TO gerekçesidir).
func classifyHandler(ctx *analysisContext, fi *funcInfo, expr ast.Expr) *callTarget {
	switch h := expr.(type) {
	case *ast.Ident:
		if samePkg, ok := ctx.pkgFuncs[fi.pkgKey][h.Name]; ok && samePkg.recv == "" {
			return &callTarget{
				ref:        NodeRef{Kind: "Function", QualifiedName: samePkg.qname, RelativePath: samePkg.file.relativePath},
				resolution: ResolutionVerified,
				rationale: fmt.Sprintf(
					"ROUTES_TO: %s is a handler function defined in package '%s' in the same directory (go/ast, verified).",
					samePkg.qname, fi.pkg,
				),
			}
		}
		return &callTarget{
			ref:        NodeRef{Kind: "UnknownExternal", QualifiedName: h.Name},
			resolution: ResolutionUnresolved,
			rationale: fmt.Sprintf(
				"ROUTES_TO: handler name '%s' did not match any defined symbol (unresolved).",
				h.Name,
			),
		}
	default:
		text := exprText(ctx.fset, fi.file.content, expr)
		target := classifyExpr(ctx, fi, expr)
		if target == nil {
			return nil
		}
		// classifyExpr gerekçesi CALLS odaklıdır; UnknownExternal metnini
		// handler bağlamında da koruyarak döndürür.
		if target.resolution == ResolutionUnresolved && text != "" {
			target.ref = NodeRef{Kind: "UnknownExternal", QualifiedName: text}
		}
		return target
	}
}
