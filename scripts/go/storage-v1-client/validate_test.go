package main

import (
	"strings"
	"testing"
)

func TestParseHex32(t *testing.T) {
	valid := repeatHex("a", 64)
	b, err := parseHex32("--x", valid)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(b) != 32 {
		t.Fatalf("got %d bytes, want 32", len(b))
	}

	badCases := []string{
		"",
		repeatHex("a", 63),        // too short
		repeatHex("a", 65),        // too long
		repeatHex("A", 64),        // uppercase not allowed
		repeatHex("g", 64),        // non-hex char
		"0x" + repeatHex("a", 62), // prefixed
	}
	for _, bad := range badCases {
		if _, err := parseHex32("--x", bad); err == nil {
			t.Errorf("parseHex32(%q) expected error, got nil", bad)
		}
	}
}

func repeatHex(ch string, n int) string {
	out := make([]byte, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, ch[0])
	}
	return string(out)
}

func TestParseRawAddr(t *testing.T) {
	hex64 := repeatHex("b", 64)

	addr, err := parseRawAddr("--provider", "0:"+hex64, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if addr.Workchain() != 0 {
		t.Fatalf("workchain = %d, want 0", addr.Workchain())
	}

	// -1 is refused when only 0 is allowed.
	if _, err := parseRawAddr("--provider", "-1:"+hex64, 0); err == nil {
		t.Fatal("expected error for workchain -1 when only 0 is allowed")
	}

	// -1 is accepted when explicitly allowed (owner-style validation).
	addrNeg, err := parseRawAddr("--owner", "-1:"+hex64, 0, -1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if addrNeg.Workchain() != -1 {
		t.Fatalf("workchain = %d, want -1", addrNeg.Workchain())
	}

	badCases := []string{
		"",
		"not-an-address",
		"0:" + repeatHex("b", 63), // wrong length
		"2:" + hex64,              // workchain not in allowlist
		hex64,                     // missing "wc:" prefix
	}
	for _, bad := range badCases {
		if _, err := parseRawAddr("--x", bad, 0, -1); err == nil {
			t.Errorf("parseRawAddr(%q) expected error, got nil", bad)
		}
	}
}

// TestParseRawAddrFriendlyFormHint locks in issue #562: rejecting an EQ.../UQ...
// (friendly-form, what every wallet app displays) address must point the
// operator at a conversion path, not just restate the required raw shape.
func TestParseRawAddrFriendlyFormHint(t *testing.T) {
	_, err := parseRawAddr("--owner", "EQD_not_a_raw_addr", 0, -1)
	if err == nil {
		t.Fatal("expected an error for a friendly-form address, got nil")
	}
	if !strings.Contains(err.Error(), "tonviewer.com") || !strings.Contains(err.Error(), "toRawString") {
		t.Errorf("expected a conversion hint (tonviewer.com / toRawString) in error, got: %v", err)
	}
}

func TestParseUint64Flag(t *testing.T) {
	n, err := parseUint64Flag("--x", "12345")
	if err != nil || n != 12345 {
		t.Fatalf("got (%d, %v), want (12345, nil)", n, err)
	}

	n, err = parseUint64Flag("--x", "0")
	if err != nil || n != 0 {
		t.Fatalf("got (%d, %v), want (0, nil)", n, err)
	}

	badCases := []string{"", "-1", "+1", "1.5", "1e3", " 1", "1 ", "abc", "0x10"}
	for _, bad := range badCases {
		if _, err := parseUint64Flag("--x", bad); err == nil {
			t.Errorf("parseUint64Flag(%q) expected error, got nil", bad)
		}
	}
}

func TestParsePositiveUint64Flag(t *testing.T) {
	if _, err := parsePositiveUint64Flag("--x", "0"); err == nil {
		t.Error("expected error for 0, got nil")
	}
	n, err := parsePositiveUint64Flag("--x", "7")
	if err != nil || n != 7 {
		t.Fatalf("got (%d, %v), want (7, nil)", n, err)
	}
}

// TestCheckRequiredFlags exercises checkRequiredFlags directly: it should
// report every missing flag in one error (not stop at the first), and
// return nil when all are present.
func TestCheckRequiredFlags(t *testing.T) {
	if err := checkRequiredFlags("cmd",
		requiredFlag{"--a", "present"},
		requiredFlag{"--b", "also-present"},
	); err != nil {
		t.Fatalf("expected nil for all-present flags, got %v", err)
	}

	err := checkRequiredFlags("cmd",
		requiredFlag{"--a", ""},
		requiredFlag{"--b", "present"},
		requiredFlag{"--c", ""},
	)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	msg := err.Error()
	if !strings.HasPrefix(msg, "cmd requires ") {
		t.Fatalf("error %q does not start with %q", msg, "cmd requires ")
	}
	if !strings.Contains(msg, "--a") || !strings.Contains(msg, "--c") {
		t.Fatalf("error %q does not mention both missing flags --a and --c", msg)
	}
	if strings.Contains(msg, "--b") {
		t.Fatalf("error %q unexpectedly mentions present flag --b", msg)
	}
}
