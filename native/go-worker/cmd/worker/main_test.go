package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseRequestModuleFiles(t *testing.T) {
	validReq := `{"id":"m1","type":"analyze","protocolVersion":"1","files":[{"path":"a/util/u.go","content":"package util\nfunc Help() {}\n"},{"path":"cmd/main.go","content":"package main\nimport \"example.com/demo/a/util\"\nfunc main() { util.Help() }\n"}],"moduleFiles":[{"relativePath":"go.mod","content":"module example.com/demo\n\ngo 1.22\n"}]}`
	out := processLine(validReq)
	var resp workerResponse
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Status != "ready" {
		t.Fatalf("expected status ready, got %q (raw=%s)", resp.Status, string(out))
	}
	foundVerified := false
	for _, e := range resp.Edges {
		if e.Kind == "CALLS" && e.From.QualifiedName == "main.main" && e.To.QualifiedName == "util.Help" && e.Resolution == "verified" {
			foundVerified = true
			break
		}
	}
	if !foundVerified {
		t.Fatalf("expected verified CALLS edge with moduleFiles go.mod, got edges=%+v", resp.Edges)
	}

	// Reject unknown field in moduleFiles[]
	unknownFieldReq := `{"id":"m2","type":"analyze","files":[{"path":"main.go","content":"package main\n"}],"moduleFiles":[{"relativePath":"go.mod","content":"module x\n","extra":1}]}`
	var errResp errorResponse
	if err := json.Unmarshal(processLine(unknownFieldReq), &errResp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if errResp.Status != "error" || errResp.Error.Code != "INVALID_ARGUMENT" {
		t.Fatalf("expected INVALID_ARGUMENT for unknown field in moduleFiles, got %+v", errResp)
	}

	// Reject path traversal in moduleFiles[]
	traversalReq := `{"id":"m3","type":"analyze","files":[{"path":"main.go","content":"package main\n"}],"moduleFiles":[{"relativePath":"../go.mod","content":"module x\n"}]}`
	errResp = errorResponse{}
	if err := json.Unmarshal(processLine(traversalReq), &errResp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if errResp.Status != "error" || errResp.Error.Code != "INVALID_ARGUMENT" {
		t.Fatalf("expected INVALID_ARGUMENT for traversal in moduleFiles, got %+v", errResp)
	}

	// Reject duplicate relativePath in moduleFiles[]
	dupReq := `{"id":"m4","type":"analyze","files":[{"path":"main.go","content":"package main\n"}],"moduleFiles":[{"relativePath":"go.mod","content":"module x\n"},{"relativePath":"go.mod","content":"module y\n"}]}`
	errResp = errorResponse{}
	if err := json.Unmarshal(processLine(dupReq), &errResp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if errResp.Status != "error" || errResp.Error.Code != "INVALID_ARGUMENT" {
		t.Fatalf("expected INVALID_ARGUMENT for duplicate moduleFiles, got %+v", errResp)
	}
}

// containsTurkishLetter reports whether s contains a Turkish-specific letter
// (listed as code points so this source stays free of them); worker output
// that reaches users and agents must be plain English.
func containsTurkishLetter(s string) bool {
	for _, r := range s {
		switch r {
		case 0x00e7, 0x011f, 0x0131, 0x00f6, 0x015f, 0x00fc,
			0x00c7, 0x011e, 0x0130, 0x00d6, 0x015e, 0x00dc:
			return true
		}
	}
	return false
}

func TestWorkerMessagesAreEnglish(t *testing.T) {
	// Protocol error: path traversal in files[].
	traversalReq := `{"id":"e1","type":"analyze","files":[{"path":"../main.go","content":"package main\n"}]}`
	var errResp errorResponse
	if err := json.Unmarshal(processLine(traversalReq), &errResp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if errResp.Error.Code != "INVALID_ARGUMENT" || errResp.Error.Message != "Source path escapes the workspace root: ../main.go" {
		t.Fatalf("expected English traversal message, got %+v", errResp.Error)
	}

	// Protocol error: missing id.
	errResp = errorResponse{}
	if err := json.Unmarshal(processLine(`{"type":"analyze","files":[{"path":"main.go","content":"package main\n"}]}`), &errResp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if errResp.Error.Message != "the id field is required" {
		t.Fatalf("expected English missing-id message, got %+v", errResp.Error)
	}

	// Evidence rationales of a successful analysis (verified and unresolved calls).
	req := `{"id":"e2","type":"analyze","files":[{"path":"main.go","content":"package main\n\nfunc helper() {}\n\nfunc main() {\n\thelper()\n\tunknownThing()\n}\n"}]}`
	out := processLine(req)
	var resp workerResponse
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	foundVerified := false
	for _, e := range resp.Edges {
		if e.Kind == "CALLS" && e.To.QualifiedName == "main.helper" && e.Resolution == "verified" {
			for _, ev := range e.Evidence {
				if strings.Contains(ev.Rationale, "resolved with go/ast to a function defined in package 'main' in the same directory (verified)") {
					foundVerified = true
				}
			}
		}
	}
	if !foundVerified {
		t.Fatalf("expected English verified CALLS rationale, got %s", string(out))
	}
	if containsTurkishLetter(string(out)) {
		t.Fatalf("worker response contains Turkish text: %s", string(out))
	}
}
