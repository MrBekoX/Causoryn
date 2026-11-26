package analyze

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// Resource-limit tests: text copied from the source into names, rationales and
// ambiguity is bounded, candidate lists are capped with explicit provenance, and
// merging the evidence of one edge stays linear. Assertions use literal bounds
// and the JSON wire form, so they describe the protocol, not the constants.

// truncatedName matches a bounded text: a prefix, "...#" and 12 hex digits of
// the SHA-256 of the full text.
var truncatedName = regexp.MustCompile(`\.\.\.#[0-9a-f]{12}$`)

// responseTexts collects every string of a result that can carry source text.
func responseTexts(res Result) []string {
	var texts []string
	for _, n := range res.Nodes {
		texts = append(texts, n.QualifiedName)
		for _, value := range n.Attributes {
			if s, ok := value.(string); ok {
				texts = append(texts, s)
			}
		}
	}
	for _, e := range res.Edges {
		texts = append(texts, e.From.QualifiedName, e.To.QualifiedName)
		for _, ev := range e.Evidence {
			texts = append(texts, ev.Rationale)
		}
		if e.Ambiguity != nil {
			texts = append(texts, e.Ambiguity.Reason)
			texts = append(texts, e.Ambiguity.Candidates...)
		}
	}
	for _, ev := range res.Evidence {
		texts = append(texts, ev.Rationale)
	}
	texts = append(texts, res.Warnings...)
	for _, d := range res.Diagnostics {
		texts = append(texts, d.Message)
	}
	return texts
}

func longestText(texts []string) int {
	longest := 0
	for _, text := range texts {
		if len(text) > longest {
			longest = len(text)
		}
	}
	return longest
}

// ambiguityJSON returns the wire form of an edge's ambiguity.
func ambiguityJSON(t *testing.T, e *Edge) map[string]any {
	t.Helper()
	if e == nil || e.Ambiguity == nil {
		t.Fatalf("expected an edge with ambiguity, got %+v", e)
	}
	raw, err := json.Marshal(e.Ambiguity)
	if err != nil {
		t.Fatalf("ambiguity could not be marshalled: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("ambiguity could not be unmarshalled: %v", err)
	}
	return out
}

func findEdgeTo(edges []Edge, kind, fromQname, toQname string) *Edge {
	for i := range edges {
		e := &edges[i]
		if e.Kind == kind && e.From.QualifiedName == fromQname && e.To.QualifiedName == toQname {
			return e
		}
	}
	return nil
}

// F10: call-expression text (nested call chains, func literal calls, chained
// selectors), long declared names and long import paths are bounded wherever
// they are copied, and the bounded texts stay distinct and deterministic.
func TestCopiedSourceTextIsBounded(t *testing.T) {
	longLiteral := strings.Repeat("<", 20_000)
	longFunc := "F" + strings.Repeat("f", 5_000)
	longImport := "other.io/" + strings.Repeat("x", 5_000)
	content := "package p\n\n" +
		"import m \"" + longImport + "\"\n\n" +
		"func h() {}\n\n" +
		"func f() {\n" +
		"\ta(\"" + longLiteral + "\")()()()\n" +
		"\t(func() { _ = \"" + strings.Repeat("y", 5_000) + "\" })()\n" +
		"\tg(\"" + longLiteral + "\").M()\n" +
		"\tm.Call()\n" +
		"\tb.c()\n" +
		"}\n\n" +
		"func " + longFunc + "() {\n" +
		"\th()\n" +
		"\th()\n" +
		"}\n"
	files := []SourceFile{{RelativePath: "p/f.go", SourceHash: "h", Content: content}}
	modules := []ModuleFile{{RelativePath: "go.mod", Content: "module example.com/demo\n"}}

	res := AnalyzeWithModules(files, modules, 0)

	// Every copied text is bounded (a bounded name is at most 512+16 bytes; a
	// rationale embeds at most a few bounded names).
	if longest := longestText(responseTexts(res)); longest > 2_000 {
		t.Fatalf("a response text is %d bytes long; copied source text must be bounded", longest)
	}

	// The nested callees a("..."), a("...")() and a("...")()(), the func literal
	// and the chained selector are five distinct bounded UnknownExternal names.
	truncated := map[string]bool{}
	for _, n := range res.Nodes {
		if n.Kind == "UnknownExternal" && truncatedName.MatchString(n.QualifiedName) {
			truncated[n.QualifiedName] = true
		}
	}
	if len(truncated) != 5 {
		t.Fatalf("expected 5 distinct truncated UnknownExternal names, got %d: %v", len(truncated), truncated)
	}

	// Short texts are not touched.
	if findNode(res.Nodes, "UnknownExternal", "b.c") == nil {
		t.Fatalf("a short call text must stay unchanged: %+v", res.Nodes)
	}

	// A long declared name is bounded on its node, and its edges use the same name.
	var longNode *Node
	for i := range res.Nodes {
		if res.Nodes[i].Kind == "Function" && strings.HasPrefix(res.Nodes[i].QualifiedName, "p.Ff") {
			longNode = &res.Nodes[i]
		}
	}
	if longNode == nil || !truncatedName.MatchString(longNode.QualifiedName) || len(longNode.QualifiedName) > 528 {
		t.Fatalf("expected a bounded Function name for the long declaration, got %+v", longNode)
	}
	call := findEdgeTo(res.Edges, EdgeCalls, longNode.QualifiedName, "p.h")
	if call == nil || call.Resolution != ResolutionVerified || len(call.Evidence) != 2 {
		t.Fatalf("expected the verified CALLS edge of the long function to use its bounded name, got %+v", call)
	}
	contains := findEdgeTo(res.Edges, EdgeContains, "p/f.go", longNode.QualifiedName)
	if contains == nil {
		t.Fatalf("expected the CONTAINS edge of the long function to use its bounded name")
	}

	// The long import path is bounded in the ambiguity reason of its call.
	importCall := findEdgeTo(res.Edges, EdgeCalls, "p.f", "m.Call")
	if importCall == nil || importCall.Ambiguity == nil || !strings.Contains(importCall.Ambiguity.Reason, "...#") {
		t.Fatalf("expected the import path to be bounded in the ambiguity reason, got %+v", importCall)
	}

	// Deterministic: the same input gives the same result.
	again := AnalyzeWithModules([]SourceFile{{RelativePath: "p/f.go", SourceHash: "h", Content: content}}, modules, 0)
	if !reflect.DeepEqual(res, again) {
		t.Fatalf("bounded output must be deterministic")
	}
}

func sortedLabels(format string, count int) []string {
	labels := make([]string, 0, count)
	for i := 0; i < count; i++ {
		labels = append(labels, fmt.Sprintf(format, i))
	}
	sort.Strings(labels)
	return labels
}

func assertCappedCandidates(t *testing.T, e *Edge, all []string) {
	t.Helper()
	wire := ambiguityJSON(t, e)
	candidates, _ := wire["candidates"].([]any)
	if len(candidates) != 64 {
		t.Fatalf("expected the candidate list to be capped at 64 entries, got %d", len(candidates))
	}
	for i, candidate := range candidates {
		if candidate != all[i] {
			t.Fatalf("candidate %d = %v, want the sorted label %q", i, candidate, all[i])
		}
	}
	if wire["candidatesTruncated"] != true {
		t.Fatalf("expected candidatesTruncated=true on a capped list, got %v", wire)
	}
	if count, _ := wire["candidateCount"].(float64); int(count) != len(all) {
		t.Fatalf("expected candidateCount=%d, got %v", len(all), wire["candidateCount"])
	}
	if reason, _ := wire["reason"].(string); !strings.Contains(reason, "candidates truncated") {
		t.Fatalf("expected the reason to state the truncation, got %q", reason)
	}
}

// F16 (and F63): candidate lists of method, interface-method and package calls
// are capped with an explicit provenance flag and the full candidate count.
func TestAmbiguityCandidateListsAreCapped(t *testing.T) {
	var methods, ifaces strings.Builder
	methods.WriteString("package p\n")
	ifaces.WriteString("package p\n")
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&methods, "type T%d struct{}\nfunc (T%d) M() {}\n", i, i)
		fmt.Fprintf(&ifaces, "type I%d interface{ N() }\n", i)
	}
	files := []SourceFile{
		{RelativePath: "p/methods.go", SourceHash: "h1", Content: methods.String()},
		{RelativePath: "p/ifaces.go", SourceHash: "h2", Content: ifaces.String()},
		{RelativePath: "p/calls.go", SourceHash: "h3", Content: "package p\n\n" +
			"type A struct{}\nfunc (A) K() {}\ntype B struct{}\nfunc (B) K() {}\n\n" +
			"func g1(x T0) { x.M() }\nfunc g2(x T0) { x.M() }\nfunc g3(x I0) { x.N() }\nfunc g4(x A) { x.K() }\n"},
	}
	for i := 0; i < 70; i++ {
		files = append(files, SourceFile{
			RelativePath: fmt.Sprintf("d%02d/util/u.go", i),
			SourceHash:   fmt.Sprintf("u%d", i),
			Content:      "package util\n\nfunc Format() {}\n",
		})
	}
	files = append(files, SourceFile{
		RelativePath: "cmd/app/main.go",
		SourceHash:   "hm",
		Content:      "package main\n\nimport \"other.io/x/util\"\n\nfunc main() {\n\tutil.Format()\n}\n",
	})

	res := Analyze(files, 0)

	methodLabels := sortedLabels("p.T%d.M", 100)
	for _, caller := range []string{"p.g1", "p.g2"} {
		e := findEdgeTo(res.Edges, EdgeCalls, caller, "x.M")
		assertCappedCandidates(t, e, methodLabels)
		if e.Resolution != ResolutionUnresolved || !strings.Contains(e.Evidence[0].Rationale, "(100 candidates)") {
			t.Fatalf("expected an unresolved edge whose rationale counts every candidate, got %+v", e)
		}
	}

	assertCappedCandidates(t, findEdgeTo(res.Edges, EdgeCalls, "p.g3", "x.N"), sortedLabels("p.I%d.N", 100))

	pkgLabels := make([]string, 0, 70)
	for i := 0; i < 70; i++ {
		pkgLabels = append(pkgLabels, fmt.Sprintf("util.Format (d%02d/util/u.go)", i))
	}
	sort.Strings(pkgLabels)
	pkgCall := findEdgeTo(res.Edges, EdgeCalls, "main.main", "util.Format")
	assertCappedCandidates(t, pkgCall, pkgLabels)
	if !strings.Contains(pkgCall.Evidence[0].Rationale, "(70 candidates)") {
		t.Fatalf("expected the package rationale to count every candidate, got %q", pkgCall.Evidence[0].Rationale)
	}

	// A list under the cap keeps its exact wire form (no provenance fields).
	small := findEdgeTo(res.Edges, EdgeCalls, "p.g4", "x.K")
	wire := ambiguityJSON(t, small)
	if _, present := wire["candidatesTruncated"]; present {
		t.Fatalf("an uncapped list must not carry candidatesTruncated: %v", wire)
	}
	if _, present := wire["candidateCount"]; present {
		t.Fatalf("an uncapped list must not carry candidateCount: %v", wire)
	}
	if got := wire["candidates"].([]any); len(got) != 2 || got[0] != "p.A.K" || got[1] != "p.B.K" {
		t.Fatalf("expected the two K candidates, got %v", got)
	}
}

// F37: merging the evidence of one edge is linear (map by key) and keeps the
// first-seen order and the de-duplication of identical evidence.
func TestEdgeEvidenceMergeIsLinear(t *testing.T) {
	const calls = 20_000
	var body strings.Builder
	body.WriteString("package p\n\nfunc a() {}\n\nfunc f() {\n") // f starts on line 5
	for i := 0; i < calls; i++ {
		body.WriteString("\ta()\n")
	}
	body.WriteString("\ta(); a()\n") // two calls on one line → one evidence
	body.WriteString("}\n")
	files := []SourceFile{{RelativePath: "p/q.go", SourceHash: "h", Content: body.String()}}

	done := make(chan Result, 1)
	go func() { done <- Analyze(files, 0) }()
	var res Result
	select {
	case res = <-done:
	case <-time.After(20 * time.Second):
		t.Fatalf("analyzing one function with %d calls to the same target did not finish within 20s (quadratic evidence merge)", calls)
	}

	e := findEdgeTo(res.Edges, EdgeCalls, "p.f", "p.a")
	if e == nil {
		t.Fatalf("expected the CALLS edge p.f -> p.a")
	}
	if len(e.Evidence) != calls+1 {
		t.Fatalf("expected %d evidence records (identical evidence de-duplicated), got %d", calls+1, len(e.Evidence))
	}
	for i, ev := range e.Evidence {
		if want := 6 + i; ev.Span == nil || ev.Span.StartLine != want {
			t.Fatalf("evidence %d is on line %v, want %d (first-seen order)", i, ev.Span, want)
		}
	}
}

// responseJSONBytes — serialized size of the nodes, edges, evidence and warnings.
func responseJSONBytes(t *testing.T, res Result) int {
	t.Helper()
	total := 0
	for _, part := range []any{res.Nodes, res.Edges, res.Evidence, res.Warnings} {
		raw, err := json.Marshal(part)
		if err != nil {
			t.Fatalf("result could not be marshalled: %v", err)
		}
		total += len(raw)
	}
	return total
}

func assertNoDanglingEdges(t *testing.T, res Result) {
	t.Helper()
	nodes := map[string]bool{}
	for _, n := range res.Nodes {
		nodes[nodeKey(NodeRef{Kind: n.Kind, QualifiedName: n.QualifiedName, RelativePath: n.RelativePath})] = true
	}
	for _, e := range res.Edges {
		if !nodes[nodeKey(e.From)] || !nodes[nodeKey(e.To)] {
			t.Fatalf("dangling edge %s %s -> %s", e.Kind, e.From.QualifiedName, e.To.QualifiedName)
		}
	}
}

// Total output: every call quotes two bounded 512+16-byte names and a bounded
// package name, so one short line still yields kilobytes of JSON. The response
// stays under a fixed size budget (below the adapter's 64 MiB line limit) and
// says so: a RESPONSE_TRUNCATED diagnostic, status partial, no dangling edges,
// the same result on every run.
func TestResponseSizeBudgetTruncatesDeterministically(t *testing.T) {
	var body strings.Builder
	body.WriteString("package " + strings.Repeat("p", 600) + "\n\nfunc a() {}\n\nfunc " + strings.Repeat("F", 600) + "() {\n")
	for i := 0; i < 15_000; i++ {
		body.WriteString("\ta()\n")
	}
	body.WriteString("}\n")
	files := []SourceFile{{RelativePath: "p/f.go", SourceHash: "h", Content: body.String()}}

	res := Analyze(files, 0)

	if size := responseJSONBytes(t, res); size > 40_000_000 {
		t.Fatalf("nodes, edges, evidence and warnings take %d bytes; the response size budget is 40000000", size)
	}
	truncated := false
	for _, d := range res.Diagnostics {
		if d.Code == "RESPONSE_TRUNCATED" && d.RelativePath == "" && d.Line == 0 && strings.Contains(d.Message, "size budget") {
			truncated = true
		}
	}
	if !truncated || res.State != "partial" {
		t.Fatalf("expected a RESPONSE_TRUNCATED size-budget diagnostic and status partial, got state=%s diagnostics=%+v", res.State, res.Diagnostics)
	}
	assertNoDanglingEdges(t, res)
	var call *Edge
	for i := range res.Edges {
		if res.Edges[i].Kind == EdgeCalls && res.Edges[i].To.Kind == "Function" {
			call = &res.Edges[i]
		}
	}
	if call == nil || len(call.Evidence) == 0 || call.Evidence[0].Span.StartLine != 6 {
		t.Fatalf("expected the CALLS edge to keep its first evidence records, got %+v", call)
	}
	again := Analyze([]SourceFile{{RelativePath: "p/f.go", SourceHash: "h", Content: body.String()}}, 0)
	if !reflect.DeepEqual(res, again) {
		t.Fatalf("a truncated result must be deterministic")
	}
}

// F16 label size: 64 candidate types with long names would put 64 bounded
// labels (~34 KB) on every caller edge. An ambiguity lists candidates only up
// to 4096 label bytes, with the provenance fields set.
func TestAmbiguityLabelBytesAreBounded(t *testing.T) {
	var types, callers strings.Builder
	types.WriteString("package p\n")
	callers.WriteString("package p\n")
	long := strings.Repeat("t", 600)
	for i := 0; i < 64; i++ {
		fmt.Fprintf(&types, "type T%02d%s struct{}\nfunc (T%02d%s) M() {}\n", i, long, i, long)
	}
	for i := 0; i < 20; i++ {
		fmt.Fprintf(&callers, "func g%d(x int) { x.M() }\n", i)
	}
	res := Analyze([]SourceFile{
		{RelativePath: "p/t.go", SourceHash: "h1", Content: types.String()},
		{RelativePath: "p/c.go", SourceHash: "h2", Content: callers.String()},
	}, 0)

	all := make([]string, 0, 64)
	for _, n := range res.Nodes {
		if n.Kind == "Method" {
			all = append(all, n.QualifiedName)
		}
	}
	sort.Strings(all)
	if len(all) != 64 {
		t.Fatalf("expected 64 methods, got %d", len(all))
	}
	for i := 0; i < 20; i++ {
		wire := ambiguityJSON(t, findEdgeTo(res.Edges, EdgeCalls, fmt.Sprintf("p.g%d", i), "x.M"))
		candidates, _ := wire["candidates"].([]any)
		total := 0
		for j, candidate := range candidates {
			label, _ := candidate.(string)
			if label != all[j] {
				t.Fatalf("candidate %d = %q, want the sorted label %q", j, label, all[j])
			}
			total += len(label)
		}
		if len(candidates) == 0 || total > 4096 {
			t.Fatalf("expected 1..4096 bytes of candidate labels, got %d candidates with %d bytes", len(candidates), total)
		}
		if wire["candidatesTruncated"] != true || wire["candidateCount"] != float64(64) {
			t.Fatalf("expected candidatesTruncated=true and candidateCount=64, got %v", wire)
		}
	}
}

// boundText cost: in a call chain a("<2 MB>")()()...() every callee text is a
// distinct prefix of the same source span; hashing each in full is quadratic
// (about 2 GB of SHA-256 per file). Texts that share a start are hashed in one
// pass, so the chains below finish quickly; digests stay the SHA-256 of the
// full text (checked on a chain within the hashing bound).
func TestLongCallChainTextIsHashedLinearly(t *testing.T) {
	const chain = 980
	var files []SourceFile
	for i := 0; i < 3; i++ {
		content := fmt.Sprintf("package p\n\nfunc f%d() { a(\"%s\")%s }\n", i, strings.Repeat("x", 1_990_000), strings.Repeat("()", chain))
		files = append(files, SourceFile{RelativePath: fmt.Sprintf("p/f%d.go", i), SourceHash: fmt.Sprintf("h%d", i), Content: content})
	}
	moderate := "package q\n\nfunc g() { b(\"" + strings.Repeat("y", 1_000) + "\")()()() }\n"
	files = append(files, SourceFile{RelativePath: "q/g.go", SourceHash: "hq", Content: moderate})

	done := make(chan Result, 1)
	go func() { done <- Analyze(files, 0) }()
	var res Result
	select {
	case res = <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("three 2 MB call chains were not analyzed within 5s (callee texts hashed in full, quadratic)")
	}

	truncated := map[string]bool{}
	for _, n := range res.Nodes {
		if n.Kind == "UnknownExternal" && truncatedName.MatchString(n.QualifiedName) {
			truncated[n.QualifiedName] = true
		}
	}
	if want := 3*chain + 3; len(truncated) != want {
		t.Fatalf("expected %d distinct truncated callee names, got %d", want, len(truncated))
	}
	// Within the hashing bound the digest is the SHA-256 of the full text.
	start := strings.Index(moderate, "b(")
	for _, end := range []int{strings.Index(moderate, "\")") + 2, strings.Index(moderate, "\")") + 4, strings.Index(moderate, "\")") + 6} {
		text := moderate[start:end]
		sum := sha256.Sum256([]byte(text))
		want := text[:200] + "...#" + hex.EncodeToString(sum[:])[:12]
		if findNode(res.Nodes, "UnknownExternal", want) == nil {
			t.Fatalf("expected the callee %q... to be named with the SHA-256 of its full text (%s)", text[:20], want[200:])
		}
	}
}
