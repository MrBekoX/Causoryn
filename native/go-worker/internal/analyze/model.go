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
	"encoding/json"
	"sort"
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

type Node struct {
	Kind          string         `json:"kind"`
	QualifiedName string         `json:"qualifiedName"`
	Language      string         `json:"language"`
	RelativePath  string         `json:"relativePath,omitempty"`
	Attributes    map[string]any `json:"attributes"`
}

type Ambiguity struct {
	Candidates []string `json:"candidates"`
	Reason     string   `json:"reason"`
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

func sortStrings(values []string) {
	sort.Strings(values)
}

// round4 — coverageRatio 4 ondalık (Roslyn worker kuralı).
func round4(ratio float64) float64 {
	return float64(int64(ratio*10000+0.5)) / 10000
}
