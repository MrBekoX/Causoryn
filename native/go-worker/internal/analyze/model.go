// Package analyze — go/parser + go/ast ile satır-bazlı JSON protokolünün
// graph çıkarımı (M1-Go dilimi; TŞ v2.1 §7 Go satırı, §8 node/edge sözleşmesi).
//
// model.go: protokol ve graph tipleri (packages/domain SnapshotNodeInput /
// SnapshotEdgeInput / SnapshotEvidenceInput GİRDİ sözleşmesiyle alan-adı
// düzeyinde hizalı — worker KİMLİK ÜRETMEZ; canonical ID merkezi normalizer
// kalır). Analyzer sabitleri, resolution tablosu ve kanonik sıralama
// yardımcıları da burada yaşar.
package analyze

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"unicode/utf8"
)

// Analyzer kimliği — Evidence.analyzerId karşılığı; TS adapter sabitiyle
// (adapters/go GO_ADAPTER_ID) aynı olmalıdır.
const AnalyzerID = "go-worker"

// AnalyzerVersion — csproj <Version> karşılığı; Evidence.analyzerVersion'a
// yazılır ve yanıttaki worker.analyzerVersion ile senkrondur.
const AnalyzerVersion = "0.1.0"

// Protokol sürümü (PROTOCOL.md v1).
const ProtocolVersion = "1"

// Kaynak sınırları (TŞ §9 resource budget; K-010: yalnızca boyut limitleri).
const (
	// MaxRequestLineChars — tek istek satırı üst sınırı (char). Aşım: satırın
	// kalanı DISCARD edilir; id:null + LIMIT_EXCEEDED yanıtı yazılır.
	MaxRequestLineChars = 64_000_000
	// MaxFileCount — istek başına dosya sayısı üst sınırı.
	MaxFileCount = 5_000
	// MaxFileContentBytes — tek dosya içeriği üst sınırı (UTF-8 bayt).
	MaxFileContentBytes = 2_000_000
	// MaxResponseNodes — yanıt node bütçesi; istek maxNodes ile altına
	// çekilebilir (1..MaxResponseNodes; dışı INVALID_ARGUMENT).
	MaxResponseNodes = 250_000
)

// MaxAstDepth — dosya başına AST gezinme derinliği sınırı. Bu sınırı aşan
// gövde çağrı çıkarımına DAHİL EDİLMEZ; dosya başına bir kez GO_AST_DEPTH
// tanısı + uyarı verilir ve analiz partial olur (Roslyn worker'daki 1000
// derinlik savunmasının Go karşılığı).
const MaxAstDepth = 1000

// Output bounds for text copied from the analyzed source. Without them one
// source string is copied into every node key, edge key, rationale and
// evidence key that quotes it, so a small file can force gigabytes of output.
const (
	// MaxRenderedTextBytes — call-expression text (UnknownExternal names and
	// the rationales that quote them); the same 200 limit and "...#<digest>"
	// marker as the Python worker's rendered expressions.
	MaxRenderedTextBytes = 200
	// MaxQualifiedNameBytes — declared qualified names and other name-like
	// source text (import paths, package names, directories) quoted in
	// rationales, ambiguity reasons and candidate labels.
	MaxQualifiedNameBytes = 512
	// MaxAmbiguityCandidates — the first N sorted candidates of an ambiguity are
	// listed; a longer list carries candidatesTruncated + candidateCount and
	// says so in its reason.
	MaxAmbiguityCandidates = 64
	// MaxAmbiguityLabelBytes — the listed candidates of one ambiguity take at
	// most this many label bytes (at least one candidate is always listed);
	// every edge of an ambiguous call repeats its list.
	MaxAmbiguityLabelBytes = 4096
	// MaxHashedTextBytes — a call-expression text longer than this is not
	// hashed: its digest is taken over its file and byte range instead (the
	// text is still identified exactly). Real call texts stay far below it.
	MaxHashedTextBytes = 65_536
	// MaxResponseBytes — serialized bytes of the nodes, edges, evidence and
	// warnings of one response. Once spent, nothing more is admitted and the
	// response gets a RESPONSE_TRUNCATED diagnostic (status partial). It stays
	// below the adapters' default response line cap (64 MiB characters).
	MaxResponseBytes = 40_000_000
	// MaxResponseLineBytes — a response line longer than this (only reachable
	// through diagnostics on top of a spent budget) is replaced by a
	// LIMIT_EXCEEDED error, which the adapters still accept.
	MaxResponseLineBytes = 60_000_000
)

// cutPrefix returns the longest prefix of s of at most limit bytes that ends
// on a UTF-8 rune boundary.
func cutPrefix(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// digestHex12 — the first 12 hex digits of a SHA-256 sum.
func digestHex12(sum []byte) string {
	return hex.EncodeToString(sum)[:12]
}

// boundText returns s when it fits in limit bytes. Otherwise it returns the
// longest prefix that fits (cut on a UTF-8 rune boundary), "...#" and the
// first 12 hex digits of the SHA-256 of the full text, so distinct texts stay
// distinct and the result is deterministic.
func boundText(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	sum := sha256.Sum256([]byte(s))
	return cutPrefix(s, limit) + "...#" + digestHex12(sum[:])
}

// responseBudget — serialized bytes admitted into a response so far.
type responseBudget struct {
	used     int
	exceeded bool
}

// charge admits n more bytes. Once a charge fails nothing more is admitted
// (sticky), so the cut does not depend on the size of later records.
func (b *responseBudget) charge(n int) bool {
	if b.exceeded || b.used+n > MaxResponseBytes {
		b.exceeded = true
		return false
	}
	b.used += n
	return true
}

// jsonSize — the serialized size of v (the same encoder as the response).
func jsonSize(v any) int {
	raw, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(raw)
}

// evidenceCost — an evidence record appears in its edge and in the top-level
// evidence list.
func evidenceCost(key string) int {
	return 2 * (len(key) + 1)
}

// boundExprText bounds call-expression text (MaxRenderedTextBytes).
func boundExprText(s string) string { return boundText(s, MaxRenderedTextBytes) }

// boundName bounds a qualified name or name-like text (MaxQualifiedNameBytes).
func boundName(s string) string { return boundText(s, MaxQualifiedNameBytes) }

// RouteDetectionCapability — CapabilitiesOut.routeDetection sabiti; TS
// adapter testleri bu dizgiyi birebir doğrular.
const RouteDetectionCapability = "go-http-handlefunc-and-gin-echo-chi-registration-pattern"

// UnsupportedConstructs — bu dilimde modellenmeyen kurulumların AÇIK beyanı
// (sessiz eksiklik yok; Roslyn worker unsupportedConstructs disiplini):
//   - semantic-type-resolution: go/types semantik model YOK; package adı ve
//     benzersiz metot adı kuralı heuristic'tir (belgelenmiştir).
//   - inline-anonymous-route-handlers: func literal handler'da Endpoint
//     korunur, ROUTES_TO üretilmez + uyarı verilir (Roslyn paraleli).
//   - builtin-function-calls: len/make/append... çağrıları CALLS üretmez.
//   - closure-call-attribution: func literal içindeki çağrılar kapsayan
//     adlı fonksiyona Yazılır (AST yaklaşımı, belgelenmiştir).
var UnsupportedConstructs = []string{
	"semantic-type-resolution",
	"inline-anonymous-route-handlers",
	"builtin-function-calls",
	"closure-call-attribution",
}

// goBuiltins — CALLS üretmeyen Go öntanımlı fonksiyonları (go/types olmadan
// bunların çağrı oldukları AST'ten bellidir ama sembol çözümlemesi anlamsızdır).
var goBuiltins = map[string]bool{
	"append": true, "cap": true, "clear": true, "close": true,
	"complex": true, "copy": true, "delete": true, "imag": true,
	"len": true, "make": true, "max": true, "min": true, "new": true,
	"panic": true, "print": true, "println": true, "real": true,
	"recover": true,
}

// Node/NodeRef/Evidence/Span/Ambiguity — domain SnapshotNodeInput /
// NodeRef / SnapshotEvidenceInput / SourceSpan karşılıkları (ID'siz).
//
// Determinizm: encoding/json map anahtarlarını sıralı yazar; struct alan
// sırası sabittir; aynı girdi → birebir aynı yanıt satırı (PROTOCOL.md §6).

type Span struct {
	RelativePath string `json:"relativePath"`
	StartLine    int    `json:"startLine"`
	EndLine      int    `json:"endLine"`
	SourceHash   string `json:"sourceHash"`
}

type Evidence struct {
	Kind            string `json:"kind"`
	Span            *Span  `json:"span,omitempty"`
	AnalyzerID      string `json:"analyzerId"`
	AnalyzerVersion string `json:"analyzerVersion"`
	Rationale       string `json:"rationale"`
}

type NodeRef struct {
	Kind          string `json:"kind"`
	QualifiedName string `json:"qualifiedName"`
	RelativePath  string `json:"relativePath,omitempty"`
}

// NodeSpan — 1-based, inclusive declaration line range of a symbol node
// (PROTOCOL.md "Node fields"). File, Endpoint and UnknownExternal nodes carry
// none.
type NodeSpan struct {
	StartLine int `json:"startLine"`
	EndLine   int `json:"endLine"`
}

type Node struct {
	Kind          string         `json:"kind"`
	QualifiedName string         `json:"qualifiedName"`
	Language      string         `json:"language"`
	RelativePath  string         `json:"relativePath,omitempty"`
	Span          *NodeSpan      `json:"span,omitempty"`
	Attributes    map[string]any `json:"attributes"`
}

// widenSpan — the smallest span covering both (nil-safe). A node declared more
// than once (two `init` functions of one file) covers every declaration; the
// result does not depend on the visit order.
func widenSpan(current, next *NodeSpan) *NodeSpan {
	if next == nil {
		return current
	}
	if current == nil {
		copied := *next
		return &copied
	}
	widened := *current
	if next.StartLine < widened.StartLine {
		widened.StartLine = next.StartLine
	}
	if next.EndLine > widened.EndLine {
		widened.EndLine = next.EndLine
	}
	return &widened
}

type Ambiguity struct {
	Candidates []string `json:"candidates"`
	Reason     string   `json:"reason"`
	// CandidatesTruncated and CandidateCount are set only when the list was
	// capped at MaxAmbiguityCandidates (omitted otherwise, so an uncapped list
	// keeps its exact wire form); CandidateCount is the full candidate count.
	CandidatesTruncated bool `json:"candidatesTruncated,omitempty"`
	CandidateCount      int  `json:"candidateCount,omitempty"`
}

// candidateList — a sorted candidate label list capped at
// MaxAmbiguityCandidates. It is built once per lookup key and shared,
// read-only, by every edge that uses it.
type candidateList struct {
	labels []string // the first sorted candidates (at most MaxAmbiguityCandidates)
	total  int      // the number of candidates before the cap
}

// capCandidates keeps the first entries of an already ordered list: at most
// MaxAmbiguityCandidates entries and MaxAmbiguityLabelBytes label bytes (the
// first entry is always kept).
func capCandidates(ordered []string) candidateList {
	kept, size := 0, 0
	for kept < len(ordered) && kept < MaxAmbiguityCandidates {
		next := size + len(ordered[kept])
		if kept > 0 && next > MaxAmbiguityLabelBytes {
			break
		}
		size = next
		kept++
	}
	if kept == len(ordered) {
		return candidateList{labels: ordered, total: len(ordered)}
	}
	labels := make([]string, kept)
	copy(labels, ordered[:kept])
	return candidateList{labels: labels, total: len(ordered)}
}

// ambiguity returns the Ambiguity of the list; a capped list sets the
// provenance fields and states the cap in its reason.
func (c candidateList) ambiguity(reason string) *Ambiguity {
	if c.total <= len(c.labels) {
		return &Ambiguity{Candidates: c.labels, Reason: reason}
	}
	return &Ambiguity{
		Candidates: c.labels,
		Reason: reason + fmt.Sprintf(
			" Only the first %d of %d sorted candidates are listed (candidates truncated).",
			len(c.labels), c.total,
		),
		CandidatesTruncated: true,
		CandidateCount:      c.total,
	}
}

type Edge struct {
	Kind       string     `json:"kind"`
	From       NodeRef    `json:"from"`
	To         NodeRef    `json:"to"`
	Resolution string     `json:"resolution"`
	Evidence   []Evidence `json:"evidence"`
	Ambiguity  *Ambiguity `json:"ambiguity,omitempty"`
}

type Diagnostic struct {
	RelativePath string `json:"relativePath"`
	Code         string `json:"code"`
	Message      string `json:"message"`
	Line         int    `json:"line"`
}

// Resolution değerleri (TŞ §8).
const (
	ResolutionVerified   = "verified"
	ResolutionHeuristic  = "heuristic"
	ResolutionUnresolved = "unresolved"
)

// Edge kind sabitleri (worker yalnızca bu üçünü üretir).
const (
	EdgeContains = "CONTAINS"
	EdgeCalls    = "CALLS"
	EdgeRoutesTo = "ROUTES_TO"
)

// Evidence kind sabitleri. route-registration, Go route kayıt çağrı kalıbı
// için dürüst addır (C#'taki route-attribute öznitelik kanıtının Go
// karşılığı değildir); Evidence.kind domain şemasında bilinçli olarak
// serbest string'dir (packages/domain graph-schema.ts notu).
const (
	EvidenceKindAstSpan  = "ast-span"
	EvidenceKindRouteReg = "route-registration"
)

// nodeKey — kenar uçlarını node kümesine bağlamak ve kenar dedupe için
// kanonik kimlik (kind + qualifiedName + relativePath).
func nodeKey(ref NodeRef) string {
	return ref.Kind + "\x00" + ref.QualifiedName + "\x00" + ref.RelativePath
}

func edgeKey(e Edge) string {
	return e.Kind + "\x00" + nodeKey(e.From) + "\x00" + nodeKey(e.To)
}

func evidenceKey(ev Evidence) string {
	bytes, err := json.Marshal(ev)
	if err != nil {
		// struct alanları yalnızca string/int → marshal hata vermez.
		return ""
	}
	return string(bytes)
}

// keyedEvidence — an evidence record with its canonical key, computed once.
type keyedEvidence struct {
	key      string
	evidence Evidence
}

// sortedEvidence orders evidence by canonical key. The keys are unique after
// de-duplication, so the order is total and deterministic; each key is
// computed once instead of on every comparison.
func sortedEvidence(keyed []keyedEvidence) []Evidence {
	if len(keyed) == 0 {
		return nil
	}
	sort.Slice(keyed, func(i, j int) bool { return keyed[i].key < keyed[j].key })
	evidence := make([]Evidence, len(keyed))
	for i := range keyed {
		evidence[i] = keyed[i].evidence
	}
	return evidence
}

func sortStrings(values []string) {
	sort.Strings(values)
}

// round4 — coverageRatio 4 ondalık (Roslyn worker kuralı).
func round4(ratio float64) float64 {
	return float64(int64(ratio*10000+0.5)) / 10000
}
