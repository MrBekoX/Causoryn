package main

import (
	"encoding/json"
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
