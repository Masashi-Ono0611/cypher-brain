package main

import (
	"bytes"
	"strings"
	"testing"
)

// allSubHeaders is every subcommand's own help-section header line, used
// below to assert a focused help output leaks none of the OTHER four.
var allSubHeaders = map[string]string{
	"deploy":           "deploy: derives the StorageV1 contract address",
	"notify":           `notify: sends the ADNL/RLDP "storageProvider.storageRequest" query`,
	"rates":            `rates: sends the ADNL/RLDP "storageProvider.ratesRequest" query`,
	"status":           "status: queries tonapi for --contract's on-chain account state.",
	"update-providers": "update-providers: REPAIR path for an ALREADY-DEPLOYED contract",
	"withdraw":         "withdraw: sends withdraw_owner (op 0x61fff683",
}

// TestSubHelpTextIsFocused pins the fix for per-subcommand --help dumping
// the entire global help text: each subcommand's own help must contain that
// subcommand's own section header and none of the other four's.
func TestSubHelpTextIsFocused(t *testing.T) {
	for sub, ownHeader := range allSubHeaders {
		t.Run(sub, func(t *testing.T) {
			got := subHelpText(sub)
			if !strings.Contains(got, ownHeader) {
				t.Fatalf("subHelpText(%q) missing its own header %q", sub, ownHeader)
			}
			for otherSub, otherHeader := range allSubHeaders {
				if otherSub == sub {
					continue
				}
				if strings.Contains(got, otherHeader) {
					t.Errorf("subHelpText(%q) unexpectedly contains %q's header %q", sub, otherSub, otherHeader)
				}
			}
			// The shared usage overview should still be present so an
			// operator asking about one subcommand sees the overall shape.
			if !strings.Contains(got, "Usage:") {
				t.Errorf("subHelpText(%q) missing the shared Usage: overview", sub)
			}
		})
	}
}

// TestSubHelpTextUnknownFallsBackToFullHelpText documents the fallback for
// an unrecognized subcommand name (should not happen in practice, since
// callers only pass this program's own subcommand names).
func TestSubHelpTextUnknownFallsBackToFullHelpText(t *testing.T) {
	if got := subHelpText("does-not-exist"); got != helpText {
		t.Fatal("subHelpText for an unknown subcommand should fall back to the full helpText")
	}
}

// TestRunNoArgsWritesHelpToStderrNotStdout pins the fix for the no-args
// case: exit 2 (an error) must not also dump the help text on stdout, since
// a caller doing `cmd 2>/dev/null` to check for real output would otherwise
// still see the full help dump on what was treated as an error.
func TestRunNoArgsWritesHelpToStderrNotStdout(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run(nil, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should be empty on the no-args error path, got %d bytes", stdout.Len())
	}
	if stderr.Len() == 0 {
		t.Fatal("stderr should contain the help text on the no-args error path, got 0 bytes")
	}
	if !strings.Contains(stderr.String(), "Usage:") {
		t.Fatal("stderr should contain the help text")
	}
}

// TestRunUnknownSubcommandWritesHelpToStderrNotStdout is the same
// stdout/stderr-vs-exit-code discipline applied to the other exit-2 path
// that also used to dump help onto stdout.
func TestRunUnknownSubcommandWritesHelpToStderrNotStdout(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"bogus-subcommand"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should be empty on the unknown-subcommand error path, got %d bytes", stdout.Len())
	}
	if !strings.Contains(stderr.String(), `unknown subcommand "bogus-subcommand"`) {
		t.Fatalf("stderr missing the unknown-subcommand message: %q", stderr.String())
	}
}

// TestRunGlobalHelpStillWritesToStdout is the control case: a genuinely
// successful invocation (exit 0) should keep using stdout, unlike the
// exit-2 error paths above.
func TestRunGlobalHelpStillWritesToStdout(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if stdout.Len() == 0 {
		t.Fatal("stdout should contain the help text on the --help path")
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr should be empty on the --help path, got %d bytes", stderr.Len())
	}
}
