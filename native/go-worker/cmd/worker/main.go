// cmd/worker — Causoryn Go sidecar worker ana süreci (M1-Go).
//
// Protokol: stdin'den satır satır JSON istek okur; her isteğe tam olarak
// BİR satır JSON yanıt döner (native/go-worker/PROTOCOL.md v1; Roslyn
// worker deseninin Go karşılığı).
//
// stdout disiplini (kırmızı çizgi): stdout'ta YALNIZCA protokol satırları
// taşınır; tüm loglar "[go-worker] " önekiyle stderr'e yazılır. Kullanıcı
// workspace'ine HİÇBİR YAZMA yapılmaz (ADR-008; analiz tamamen
// bellek-içindedir — go/parser kaynakları stdin'den alır).
//
// Sürücünün derlenmesi: `go build ./...` (sıfır dış bağımlılık — yalnızca
// Go stdlib); `go run ./cmd/worker` ile de çalıştırılabilir.
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strings"

	"causoryn/go-worker/internal/analyze"
)

const logPrefix = "[go-worker] "

func logStderr(message string) {
	fmt.Fprintln(os.Stderr, logPrefix+message)
}

// apiError — TŞ §10.1 + K-008 hata kodu kümesiyle sınırlı istek düzeyi hata
// (worker kendi kodunu İCAT ETMEZ: INVALID_ARGUMENT / LIMIT_EXCEEDED /
// INTERNAL_ERROR).
type apiError struct {
	code    string
	message string
}

func (e *apiError) Error() string { return e.code + ": " + e.message }

func invalidArgument(message string) *apiError {
	return &apiError{code: "INVALID_ARGUMENT", message: message}
}

func limitExceeded(message string) *apiError {
	return &apiError{code: "LIMIT_EXCEEDED", message: message}
}

// Yanıt şemaları (PROTOCOL.md §3, §4). Alan sırası sabittir; encoding/json
// map anahtarlarını sıralı yazdığından aynı girdi → birebir aynı satır.

type workerInfo struct {
	AnalyzerID      string `json:"analyzerId"`
	AnalyzerVersion string `json:"analyzerVersion"`
}

type capabilitiesOut struct {
	ASTParse         bool   `json:"astParse"`
	SymbolResolution bool   `json:"symbolResolution"`
	ContainsEdges    bool   `json:"containsEdges"`
	CallEdges        bool   `json:"callEdges"`
	ImportEdges      bool   `json:"importEdges"`
	RouteDetection   string `json:"routeDetection"`
	FrameworkLinkers bool   `json:"frameworkLinkers"`
}

func defaultCapabilities() capabilitiesOut {
	// Dürüstlük beyanı: go/types semantik çözümleme bu dilimde YOK —
	// package adı ve benzersiz metot adı kuralları heuristic'tir.
	return capabilitiesOut{
		ASTParse:         true,
		SymbolResolution: false,
		ContainsEdges:    true,
		CallEdges:        true,
		ImportEdges:      false,
		RouteDetection:   analyze.RouteDetectionCapability,
		FrameworkLinkers: false,
	}
}

type workerResponse struct {
	ID                    json.RawMessage      `json:"id"`
	ProtocolVersion       string               `json:"protocolVersion"`
	Status                string               `json:"status"`
	Worker                workerInfo           `json:"worker"`
	Capabilities          capabilitiesOut      `json:"capabilities"`
	CoverageRatio         float64              `json:"coverageRatio"`
	UnsupportedConstructs []string             `json:"unsupportedConstructs"`
	Warnings              []string             `json:"warnings"`
	Diagnostics           []analyze.Diagnostic `json:"diagnostics"`
	Nodes                 []analyze.Node       `json:"nodes"`
	Edges                 []analyze.Edge       `json:"edges"`
	Evidence              []analyze.Evidence   `json:"evidence"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	ID              json.RawMessage `json:"id"`
	ProtocolVersion string          `json:"protocolVersion"`
	Status          string          `json:"status"`
	Error           errorBody       `json:"error"`
}

// fileInput — files[] öğesi (kesin şema: bilinmeyen alan reddedilir).
type fileInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// moduleFileInput — opsiyonel moduleFiles[] öğesi (go.mod dosyaları).
type moduleFileInput struct {
	RelativePath string `json:"relativePath"`
	Content      string `json:"content"`
}

var allowedTopLevelFields = map[string]bool{
	"id":              true,
	"type":            true,
	"protocolVersion": true,
	"files":           true,
	"moduleFiles":     true,
	"maxNodes":        true,
}

var allowedFileFields = map[string]bool{
	"path":    true,
	"content": true,
}

var driveLetterPattern = regexp.MustCompile(`^[a-zA-Z]:`)

// normalizeRelativePath — workspace-relative POSIX yol sözleşmesi; mutlak
// yol, ""/"/"..., "." segmentleri reddedilir (Roslyn worker kuralının aynısı).
func normalizeRelativePath(raw string) (string, *apiError) {
	posix := strings.ReplaceAll(raw, "\\", "/")
	if strings.HasPrefix(posix, "/") || driveLetterPattern.MatchString(posix) {
		return "", invalidArgument("Absolute source paths are not accepted: " + raw)
	}
	for _, segment := range strings.Split(posix, "/") {
		if segment == "" || segment == "." {
			return "", invalidArgument("Source path contains an empty or invalid segment: " + raw)
		}
		if segment == ".." {
			return "", invalidArgument("Source path escapes the workspace root: " + raw)
		}
	}
	return posix, nil
}

// decodeStrictFields — istek satırını kesin şemayla alan haritasına açar.
// files[] bilinmeyen alanları ayrıca doğrulanır (fileInput alanları).
func decodeStrictFields(line string) (map[string]json.RawMessage, *apiError) {
	var fields map[string]json.RawMessage
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fields); err != nil {
		return nil, invalidArgument("request line is not valid JSON: " + err.Error())
	}
	for key := range fields {
		if !allowedTopLevelFields[key] {
			return nil, invalidArgument(fmt.Sprintf("unknown top-level field is not accepted: %q", key))
		}
	}
	return fields, nil
}

// echoableID — id alanını (varsa) string/sayı tipinde doğrular; echo değeri
// birebir ham JSON olarak döner (PROTOCOL.md: id istekteki değerle echo).
func echoableID(fields map[string]json.RawMessage) (json.RawMessage, *apiError) {
	raw, present := fields["id"]
	if !present {
		return json.RawMessage("null"), invalidArgument("the id field is required")
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return json.RawMessage("null"), invalidArgument("id must be a string or a number")
	}
	switch value.(type) {
	case string, float64:
		return raw, nil
	default:
		return json.RawMessage("null"), invalidArgument("id must be a string or a number")
	}
}

// parseRequest — kesin şema + kaynak sınırları (TŞ §9; K-010) doğrulaması.
func parseRequest(line string) ([]analyze.SourceFile, []analyze.ModuleFile, int, json.RawMessage, *apiError) {
	fields, perr := decodeStrictFields(line)
	if perr != nil {
		return nil, nil, 0, json.RawMessage("null"), perr
	}
	echo, perr := echoableID(fields)
	if perr != nil {
		return nil, nil, 0, echo, perr
	}

	typeRaw, present := fields["type"]
	if !present {
		return nil, nil, 0, echo, invalidArgument("the type field is required")
	}
	var typeName string
	if err := json.Unmarshal(typeRaw, &typeName); err != nil || typeName != "analyze" {
		return nil, nil, 0, echo, invalidArgument("only type \"analyze\" is supported")
	}

	if raw, present := fields["protocolVersion"]; present {
		var version string
		if err := json.Unmarshal(raw, &version); err != nil || version != analyze.ProtocolVersion {
			return nil, nil, 0, echo, invalidArgument(fmt.Sprintf("unsupported protocolVersion; must be %q", analyze.ProtocolVersion))
		}
	}

	filesRaw, present := fields["files"]
	if !present {
		return nil, nil, 0, echo, invalidArgument("the files field is required")
	}
	var rawFiles []json.RawMessage
	if err := json.Unmarshal(filesRaw, &rawFiles); err != nil {
		return nil, nil, 0, echo, invalidArgument("files array is invalid: " + err.Error())
	}
	inputs := make([]fileInput, 0, len(rawFiles))
	for _, rawFile := range rawFiles {
		// Kesin şema: files[] öğelerinde bilinmeyen alan reddedilir.
		fileDecoder := json.NewDecoder(bytes.NewReader(rawFile))
		fileDecoder.DisallowUnknownFields()
		var input fileInput
		if err := fileDecoder.Decode(&input); err != nil {
			return nil, nil, 0, echo, invalidArgument("files entry is invalid (including unknown fields): " + err.Error())
		}
		inputs = append(inputs, input)
	}
	if len(inputs) == 0 {
		return nil, nil, 0, echo, invalidArgument("files must contain at least 1 file")
	}
	if len(inputs) > analyze.MaxFileCount {
		return nil, nil, 0, echo, limitExceeded(fmt.Sprintf("files count limit exceeded: %d > %d", len(inputs), analyze.MaxFileCount))
	}

	var moduleFiles []analyze.ModuleFile
	if modRaw, present := fields["moduleFiles"]; present {
		var rawMods []json.RawMessage
		if err := json.Unmarshal(modRaw, &rawMods); err != nil {
			return nil, nil, 0, echo, invalidArgument("moduleFiles array is invalid: " + err.Error())
		}
		if len(rawMods) > analyze.MaxFileCount {
			return nil, nil, 0, echo, limitExceeded(fmt.Sprintf("moduleFiles count limit exceeded: %d > %d", len(rawMods), analyze.MaxFileCount))
		}
		seenMods := map[string]bool{}
		moduleFiles = make([]analyze.ModuleFile, 0, len(rawMods))
		for _, rawMod := range rawMods {
			modDecoder := json.NewDecoder(bytes.NewReader(rawMod))
			modDecoder.DisallowUnknownFields()
			var mf moduleFileInput
			if err := modDecoder.Decode(&mf); err != nil {
				return nil, nil, 0, echo, invalidArgument("moduleFiles entry is invalid (including unknown fields): " + err.Error())
			}
			if len(mf.Content) > analyze.MaxFileContentBytes {
				return nil, nil, 0, echo, limitExceeded(fmt.Sprintf("module file content size limit exceeded: %d > %d bytes", len(mf.Content), analyze.MaxFileContentBytes))
			}
			relPath, verr := normalizeRelativePath(mf.RelativePath)
			if verr != nil {
				return nil, nil, 0, echo, verr
			}
			if seenMods[relPath] {
				return nil, nil, 0, echo, invalidArgument("The same module file path was given twice: " + relPath)
			}
			seenMods[relPath] = true
			moduleFiles = append(moduleFiles, analyze.ModuleFile{
				RelativePath: relPath,
				Content:      mf.Content,
			})
		}
	}

	budget := 0
	if raw, present := fields["maxNodes"]; present {
		var value float64
		if err := json.Unmarshal(raw, &value); err != nil || value != math.Trunc(value) {
			return nil, nil, 0, echo, invalidArgument("maxNodes must be an integer")
		}
		if value < 1 || value > analyze.MaxResponseNodes {
			return nil, nil, 0, echo, invalidArgument(fmt.Sprintf("maxNodes must be in the range 1..%d", analyze.MaxResponseNodes))
		}
		budget = int(value)
	}

	seen := map[string]bool{}
	sources := make([]analyze.SourceFile, 0, len(inputs))
	for _, input := range inputs {
		if len(input.Content) > analyze.MaxFileContentBytes {
			return nil, nil, 0, echo, limitExceeded(fmt.Sprintf("file content size limit exceeded: %d > %d bytes", len(input.Content), analyze.MaxFileContentBytes))
		}
		relativePath, verr := normalizeRelativePath(input.Path)
		if verr != nil {
			return nil, nil, 0, echo, verr
		}
		if seen[relativePath] {
			return nil, nil, 0, echo, invalidArgument("The same source path was given twice: " + relativePath)
		}
		seen[relativePath] = true
		sum := sha256.Sum256([]byte(input.Content))
		sources = append(sources, analyze.SourceFile{
			RelativePath: relativePath,
			Content:      input.Content,
			SourceHash:   hex.EncodeToString(sum[:]),
		})
	}

	return sources, moduleFiles, budget, echo, nil
}

func buildResponse(echo json.RawMessage, result analyze.Result) []byte {
	if result.Warnings == nil {
		result.Warnings = []string{}
	}
	if result.Diagnostics == nil {
		result.Diagnostics = []analyze.Diagnostic{}
	}
	if result.Nodes == nil {
		result.Nodes = []analyze.Node{}
	}
	if result.Edges == nil {
		result.Edges = []analyze.Edge{}
	}
	if result.Evidence == nil {
		result.Evidence = []analyze.Evidence{}
	}
	response := workerResponse{
		ID:                    echo,
		ProtocolVersion:       analyze.ProtocolVersion,
		Status:                result.State,
		Worker:                workerInfo{AnalyzerID: analyze.AnalyzerID, AnalyzerVersion: analyze.AnalyzerVersion},
		Capabilities:          defaultCapabilities(),
		CoverageRatio:         result.CoverageRatio,
		UnsupportedConstructs: analyze.UnsupportedConstructs,
		Warnings:              result.Warnings,
		Diagnostics:           result.Diagnostics,
		Nodes:                 result.Nodes,
		Edges:                 result.Edges,
		Evidence:              result.Evidence,
	}
	payload, err := json.Marshal(response)
	if err != nil {
		logStderr("response could not be serialized: " + err.Error())
		return errorPayload(json.RawMessage("null"), &apiError{code: "INTERNAL_ERROR", message: "response could not be serialized"})
	}
	return payload
}

func errorPayload(echo json.RawMessage, apiErr *apiError) []byte {
	payload, err := json.Marshal(errorResponse{
		ID:              echo,
		ProtocolVersion: analyze.ProtocolVersion,
		Status:          "error",
		Error:           errorBody{Code: apiErr.code, Message: apiErr.message},
	})
	if err != nil {
		// Son çare: sabit satır (marshal struct alanlarıyla pratikte imkânsız).
		return []byte(`{"id":null,"protocolVersion":"1","status":"error","error":{"code":"INTERNAL_ERROR","message":"response could not be serialized"}}`)
	}
	return payload
}

// processLine — tek istek satırını yanıt JSON'una çevirir. Dosya düzeyi
// sorunlar HATA DEĞİLDİR (status:"partial" + diagnostics); yalnızca istek
// düzeyi sorunlar status:"error" üretir ve döngü DEVAM EDER.
func processLine(line string) []byte {
	sources, moduleFiles, budget, echo, perr := parseRequest(line)
	if perr != nil {
		return errorPayload(echo, perr)
	}
	result := analyze.AnalyzeWithModules(sources, moduleFiles, budget)
	return buildResponse(echo, result)
}

// safeProcessLine — beklenmeyen panic INTERNAL_ERROR yanıtıya yakalanır;
// süreç yaşar, sonraki satır işlenir (motor izolasyonu).
func safeProcessLine(line string) (payload []byte) {
	defer func() {
		if recovered := recover(); recovered != nil {
			logStderr(fmt.Sprintf("INTERNAL_ERROR: %v", recovered))
			payload = errorPayload(json.RawMessage("null"), &apiError{
				code:    "INTERNAL_ERROR",
				message: fmt.Sprintf("analyzer stopped with an unexpected error: %v", recovered),
			})
		}
	}()
	return processLine(line)
}

// readRequestLine — satır okuma + MaxRequestLineChars disiplini: sınır aşılırsa
// satırın KALANI DISCARD edilir (newline'a kadar) ve overLimit=true döner.
func readRequestLine(reader *bufio.Reader) (line string, overLimit bool, eof bool, readErr error) {
	var builder strings.Builder
	over := false
	for {
		chunk, err := reader.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) {
				if builder.Len() == 0 && !over {
					return "", false, true, nil
				}
				// Son satırda newline yoksa da istek olarak işlenir
				// (boş olmayan satır bir istektir).
				return builder.String(), over, true, nil
			}
			return "", false, false, err
		}
		if chunk == '\n' {
			if over {
				return "", true, false, nil
			}
			return builder.String(), false, false, nil
		}
		if !over {
			if builder.Len() >= analyze.MaxRequestLineChars {
				over = true
				builder.Reset()
				logStderr("request line exceeded the character limit; discarding the rest of the line")
				continue
			}
			builder.WriteByte(chunk)
		}
	}
}

func writeResponseLine(writer *bufio.Writer, payload []byte) {
	if _, err := writer.Write(payload); err != nil {
		logStderr("stdout write failed: " + err.Error())
		os.Exit(1)
	}
	if err := writer.WriteByte('\n'); err != nil {
		logStderr("stdout write failed: " + err.Error())
		os.Exit(1)
	}
	if err := writer.Flush(); err != nil {
		logStderr("stdout flush failed: " + err.Error())
		os.Exit(1)
	}
}

func main() {
	logStderr(fmt.Sprintf(
		"worker started (protocol v%s; analyzer %s@%s; stdlib-only go/parser+go/ast)",
		analyze.ProtocolVersion, analyze.AnalyzerID, analyze.AnalyzerVersion,
	))
	reader := bufio.NewReaderSize(os.Stdin, 256*1024)
	writer := bufio.NewWriter(os.Stdout)
	for {
		line, overLimit, eof, readErr := readRequestLine(reader)
		if readErr != nil {
			logStderr("stdin read error: " + readErr.Error())
			os.Exit(1)
		}
		if overLimit {
			writeResponseLine(writer, errorPayload(json.RawMessage("null"), limitExceeded(
				fmt.Sprintf("request line exceeded the %d character limit", analyze.MaxRequestLineChars),
			)))
		}
		if eof && strings.TrimSpace(line) == "" {
			break
		}
		if strings.TrimSpace(line) != "" {
			writeResponseLine(writer, safeProcessLine(strings.TrimRight(line, "\r")))
		}
		if eof {
			break
		}
	}
	logStderr("stdin EOF — worker exiting with code 0")
}
