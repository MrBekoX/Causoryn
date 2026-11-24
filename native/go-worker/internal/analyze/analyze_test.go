package analyze

import (
	"testing"
)

func findCallEdge(edges []Edge, fromQname, toQname string) *Edge {
	for i := range edges {
		e := &edges[i]
		if e.Kind == EdgeCalls && e.From.QualifiedName == fromQname && e.To.QualifiedName == toQname {
			return e
		}
	}
	return nil
}

func findCallEdgeWithPaths(edges []Edge, fromPath, fromQname, toPath, toQname string) *Edge {
	for i := range edges {
		e := &edges[i]
		if e.Kind == EdgeCalls &&
			e.From.RelativePath == fromPath &&
			e.From.QualifiedName == fromQname &&
			e.To.RelativePath == toPath &&
			e.To.QualifiedName == toQname {
			return e
		}
	}
	return nil
}

func TestMultiFilePackageCrossFileCallsAreVerified(t *testing.T) {
	files := []SourceFile{
		{
			RelativePath: "pkg/orders/handler.go",
			SourceHash:   "h1",
			Content: `package orders

func HandleOrder() {
	validateOrder()
}
`,
		},
		{
			RelativePath: "pkg/orders/validate.go",
			SourceHash:   "h2",
			Content: `package orders

type Validator struct{}

func validateOrder() {}
`,
		},
		{
			RelativePath: "pkg/orders/validator_methods.go",
			SourceHash:   "h3",
			Content: `package orders

func (v *Validator) Check() {}
`,
		},
		{
			RelativePath: "cmd/app/main.go",
			SourceHash:   "h4",
			Content: `package main

import "example.com/shop/pkg/orders"

func main() {
	orders.HandleOrder()
}
`,
		},
	}

	res := Analyze(files, 0)

	// 1) Intra-package cross-file bare call in same directory -> verified!
	crossFile := findCallEdgeWithPaths(res.Edges, "pkg/orders/handler.go", "orders.HandleOrder", "pkg/orders/validate.go", "orders.validateOrder")
	if crossFile == nil {
		t.Fatalf("expected cross-file same-package CALLS edge orders.HandleOrder -> orders.validateOrder")
	}
	if crossFile.Resolution != ResolutionVerified {
		t.Fatalf("expected verified resolution for same-dir multi-file call, got %q", crossFile.Resolution)
	}

	// 2) Cross-file method CONTAINS binding in same directory -> verified!
	foundMethodContains := false
	for _, e := range res.Edges {
		if e.Kind == EdgeContains &&
			e.From.QualifiedName == "orders.Validator" &&
			e.From.RelativePath == "pkg/orders/validate.go" &&
			e.To.QualifiedName == "orders.Validator.Check" &&
			e.To.RelativePath == "pkg/orders/validator_methods.go" {
			foundMethodContains = true
			break
		}
	}
	if !foundMethodContains {
		t.Fatalf("expected cross-file CONTAINS edge orders.Validator -> orders.Validator.Check")
	}

	// 3) External package calling into a 3-file package (without go.mod) MUST still resolve as heuristic
	//    (previously pkgCount["orders"] == 3 broke uniquePkg("orders")!).
	pkgCall := findCallEdgeWithPaths(res.Edges, "cmd/app/main.go", "main.main", "pkg/orders/handler.go", "orders.HandleOrder")
	if pkgCall == nil {
		t.Fatalf("expected CALLS edge main.main -> orders.HandleOrder for multi-file package")
	}
	if pkgCall.Resolution != ResolutionHeuristic {
		t.Fatalf("expected heuristic resolution without go.mod, got %q", pkgCall.Resolution)
	}
	if pkgCall.Ambiguity == nil {
		t.Fatalf("expected explicit ambiguity without go.mod")
	}
}

func TestDualMainPackagesDoNotCollideIntoFalseVerified(t *testing.T) {
	files := []SourceFile{
		{
			RelativePath: "cmd/api/main.go",
			SourceHash:   "h-api",
			Content: `package main

type App struct{}

func runAPI() {
	shared()
	onlyInWorker()
}

func shared() {}
`,
		},
		{
			RelativePath: "cmd/worker/main.go",
			SourceHash:   "h-worker",
			Content: `package main

func (a *App) Boot() {}

func onlyInWorker() {}

func shared() {}
`,
		},
	}

	res := Analyze(files, 0)

	// 1) cmd/api calling onlyInWorker() MUST NOT falsely link to cmd/worker/main.go!
	falseCrossMain := findCallEdgeWithPaths(res.Edges, "cmd/api/main.go", "main.runAPI", "cmd/worker/main.go", "main.onlyInWorker")
	if falseCrossMain != nil {
		t.Fatalf("forbidden false cross-directory main CALLS edge found: %+v", falseCrossMain)
	}
	unresolvedWorkerCall := findCallEdge(res.Edges, "main.runAPI", "onlyInWorker")
	if unresolvedWorkerCall == nil || unresolvedWorkerCall.Resolution != ResolutionUnresolved || unresolvedWorkerCall.To.Kind != "UnknownExternal" {
		t.Fatalf("expected unresolved UnknownExternal edge for onlyInWorker from cmd/api, got %+v", unresolvedWorkerCall)
	}

	// 2) cmd/api calling shared() MUST resolve ONLY to cmd/api/main.go (NOT cmd/worker/main.go)!
	apiShared := findCallEdgeWithPaths(res.Edges, "cmd/api/main.go", "main.runAPI", "cmd/api/main.go", "main.shared")
	if apiShared == nil || apiShared.Resolution != ResolutionVerified {
		t.Fatalf("expected verified intra-directory call cmd/api/main.go -> cmd/api/main.go main.shared, got %+v", apiShared)
	}
	wrongShared := findCallEdgeWithPaths(res.Edges, "cmd/api/main.go", "main.runAPI", "cmd/worker/main.go", "main.shared")
	if wrongShared != nil {
		t.Fatalf("cmd/api/main.go must NOT resolve shared() to cmd/worker/main.go: %+v", wrongShared)
	}

	// 3) cmd/worker method Boot() MUST NOT attach CONTAINS to cmd/api's type App!
	for _, e := range res.Edges {
		if e.Kind == EdgeContains && e.From.RelativePath == "cmd/api/main.go" && e.To.RelativePath == "cmd/worker/main.go" {
			t.Fatalf("forbidden cross-directory CONTAINS edge between two package main dirs: %+v", e)
		}
	}
}

func TestGoModExactImportResolutionAndBasenameAmbiguityHonesty(t *testing.T) {
	files := []SourceFile{
		{
			RelativePath: "a/util/util.go",
			SourceHash:   "h-a",
			Content: `package util

func Format() string { return "a" }
`,
		},
		{
			RelativePath: "b/util/util.go",
			SourceHash:   "h-b",
			Content: `package util

func Format() string { return "b" }
`,
		},
		{
			RelativePath: "cmd/app/main.go",
			SourceHash:   "h-main",
			Content: `package main

import "example.com/demo/a/util"

func main() {
	util.Format()
}
`,
		},
	}

	// (1) WITH go.mod -> exact module path resolution to a/util -> verified!
	modFiles := []ModuleFile{
		{
			RelativePath: "go.mod",
			Content:      "module example.com/demo\n\ngo 1.22\n",
		},
	}
	withMod := AnalyzeWithModules(files, modFiles, 0)
	exactEdge := findCallEdgeWithPaths(withMod.Edges, "cmd/app/main.go", "main.main", "a/util/util.go", "util.Format")
	if exactEdge == nil {
		t.Fatalf("expected exact go.mod CALLS edge to a/util/util.go, edges=%+v", withMod.Edges)
	}
	if exactEdge.Resolution != ResolutionVerified {
		t.Fatalf("expected verified resolution with go.mod exact match, got %q", exactEdge.Resolution)
	}
	if badEdge := findCallEdgeWithPaths(withMod.Edges, "cmd/app/main.go", "main.main", "b/util/util.go", "util.Format"); badEdge != nil {
		t.Fatalf("must not resolve to b/util/util.go when importing a/util: %+v", badEdge)
	}

	// (2) WITHOUT go.mod (path suffix matches a/util) -> MUST NEVER be verified; must be heuristic + ambiguity!
	withoutMod := Analyze(files, 0)
	suffixEdge := findCallEdgeWithPaths(withoutMod.Edges, "cmd/app/main.go", "main.main", "a/util/util.go", "util.Format")
	if suffixEdge == nil {
		t.Fatalf("expected heuristic CALLS edge without go.mod, edges=%+v", withoutMod.Edges)
	}
	if suffixEdge.Resolution == ResolutionVerified {
		t.Fatalf("MUST NOT emit verified without go.mod exact match!")
	}
	if suffixEdge.Resolution != ResolutionHeuristic || suffixEdge.Ambiguity == nil {
		t.Fatalf("expected heuristic + explicit ambiguity without go.mod, got %+v", suffixEdge)
	}

	// (3) WITHOUT go.mod AND import matches multiple directories ONLY by basename ("other.io/x/util"):
	//     MUST NEVER emit verified; must emit unresolved/heuristic with explicit ambiguity listing both candidates!
	ambiguousFiles := []SourceFile{
		files[0],
		files[1],
		{
			RelativePath: "cmd/app/main.go",
			SourceHash:   "h-main2",
			Content: `package main

import "other.io/x/util"

func main() {
	util.Format()
}
`,
		},
	}
	ambigRes := Analyze(ambiguousFiles, 0)
	for _, e := range ambigRes.Edges {
		if e.Kind == EdgeCalls && e.Resolution == ResolutionVerified {
			t.Fatalf("ambiguous basename import MUST NEVER emit verified edge: %+v", e)
		}
	}
	ambigCall := findCallEdge(ambigRes.Edges, "main.main", "util.Format")
	if ambigCall == nil {
		t.Fatalf("expected CALLS edge for ambiguous util.Format, edges=%+v", ambigRes.Edges)
	}
	if ambigCall.Ambiguity == nil || len(ambigCall.Ambiguity.Candidates) < 2 {
		t.Fatalf("expected explicit ambiguity with >=2 candidates for colliding package dirs, got %+v", ambigCall)
	}
}
