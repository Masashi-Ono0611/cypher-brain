package main

import (
	"bytes"
	"regexp"
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
// case: an error must not also dump the help text on stdout, since a caller
// doing `cmd 2>/dev/null` to check for real output would otherwise still see
// the full help dump on what was treated as an error.
func TestRunNoArgsWritesHelpToStderrNotStdout(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run(nil, &stdout, &stderr)
	// #750: no-args is a usage mistake, exit 1 — exit 2 is reserved for
	// guardError (a deliberate on-chain-safety refusal), never a bare
	// invocation error. See TestRunGuardErrorExitsAsTwoNotOne for the
	// positive control on the other side of that line.
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
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
// stdout/stderr-vs-exit-code discipline applied to the other usage-error
// path that also used to dump help onto stdout.
func TestRunUnknownSubcommandWritesHelpToStderrNotStdout(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"bogus-subcommand"}, &stdout, &stderr)
	// #750: same usage-mistake category as no-args above — exit 1, not 2.
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should be empty on the unknown-subcommand error path, got %d bytes", stdout.Len())
	}
	if !strings.Contains(stderr.String(), `unknown subcommand "bogus-subcommand"`) {
		t.Fatalf("stderr missing the unknown-subcommand message: %q", stderr.String())
	}
}

// TestRunMissingRequiredFlagExitsAsOne pins the third "you invoked this
// wrong" shape from #750 alongside the two above: a plain (non-guardError)
// usage error from a subcommand's own flag parsing must also exit 1, the
// same code as no-args/unknown-subcommand, so a caller can rely on exit code
// 1 meaning "usage mistake" across all three shapes.
func TestRunMissingRequiredFlagExitsAsOne(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"status"}, &stdout, &stderr) // status requires --contract
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
}

// TestRunGuardErrorExitsAsTwoNotOne is the positive control for #750: a
// genuine guardError (semantic on-chain-safety refusal) must still exit 2,
// proving the fix narrowed exit 2 to guardError specifically rather than
// accidentally collapsing it to 1 for everything.
func TestRunGuardErrorExitsAsTwoNotOne(t *testing.T) {
	var stdout, stderr bytes.Buffer
	// --max-spend-ton far too small for the computed amount triggers
	// buildDeploy's guardf() refusal (see deploy_test.go's
	// TestRunDeployOfflineGuardExitsAsGuardError for the same trigger at the
	// runDeploy level) without touching the network.
	args := []string{
		"deploy",
		"--bag-id", strings.Repeat("a", 64),
		"--provider-pubkey", strings.Repeat("b", 64),
		"--owner", "0:" + strings.Repeat("c", 64),
		"--rate-nano-per-mb-day", "1000",
		"--span-days", "7",
		"--size-bytes", "500000000",
		"--piece-size", "131072",
		"--merkle-hash", strings.Repeat("d", 64),
		"--max-spend-ton", "0.0001", // far too small
	}
	code := run(args, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2 for a guardError refusal", code)
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

// flagDescColumnRE captures a "--flag" or "--flag <value>" token (group 1)
// plus the run of spaces before its description text starts (group 2), for
// any line opening a subcommand's own --flag entry.
var flagDescColumnRE = regexp.MustCompile(`(?m)^(  --\S+(?: <\S+>)?)( +)\S`)

// assertOneAlignmentColumn is #752's regression check: within a single
// subcommand's help block, every --flag's own description (first line) must
// start at the same column as every other --flag's, and every wrapped
// continuation line must likewise share one column — a hand-typed padding
// drift (--gas-ton's own stray extra space, or --rate-nano-per-mb-day being
// 2 characters longer than every other deploy flag and never repadded) must
// not silently reappear.
func assertOneAlignmentColumn(t *testing.T, sub, help string) {
	t.Helper()
	flagCols := map[int]bool{}
	for _, m := range flagDescColumnRE.FindAllStringSubmatch(help, -1) {
		flagCols[len(m[1])+len(m[2])] = true
	}
	if len(flagCols) > 1 {
		t.Errorf("%s --help: flag descriptions start at %d different columns (want 1): %v", sub, len(flagCols), flagCols)
	}

	contCols := map[int]bool{}
	lines := strings.Split(help, "\n")
	for i, line := range lines {
		if !flagDescColumnRE.MatchString(line) {
			continue
		}
		// Walk forward over this flag's own wrapped continuation lines: any
		// line indented 3+ spaces that is not itself a new --flag entry. A
		// blank line, a new --flag line, or a line indented less than 3
		// spaces (e.g. a following prose paragraph) ends this flag's block.
		for j := i + 1; j < len(lines); j++ {
			next := lines[j]
			trimmed := strings.TrimLeft(next, " ")
			if next == "" || strings.HasPrefix(trimmed, "--") || !strings.HasPrefix(next, "   ") {
				break
			}
			contCols[len(next)-len(trimmed)] = true
		}
	}
	if len(contCols) > 1 {
		t.Errorf("%s --help: wrapped continuation lines start at %d different columns (want 1): %v", sub, len(contCols), contCols)
	}
}

// TestHelpFlagDescriptionsShareOneColumn pins #752: deploy/update-providers/
// withdraw's --help text had hand-typed padding that drifted per-flag
// (--rate-nano-per-mb-day sat 3 columns right of its deploy siblings,
// --gas-ton sat 1 column right of its update-providers siblings, and
// --contract/--max-spend-ton/--mainnet sat 1 column left of their withdraw
// siblings). notify/rates/status were already internally consistent and are
// included here as a positive control: this test must keep passing for them
// unchanged, proving the assertion itself isn't vacuously true.
func TestHelpFlagDescriptionsShareOneColumn(t *testing.T) {
	for sub, help := range subcommandHelp {
		t.Run(sub, func(t *testing.T) {
			assertOneAlignmentColumn(t, sub, help)
		})
	}
}
