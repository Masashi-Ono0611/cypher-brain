package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestBuildUpdateProvidersBodyValidation(t *testing.T) {
	pubkey := bytes.Repeat([]byte{0xbb}, 32)
	cases := []struct {
		name     string
		pubkey   []byte
		rate     uint64
		spanDays uint64
	}{
		{"short pubkey", pubkey[:31], 800, 192},
		{"zero rate", pubkey, 0, 192},
		{"zero span", pubkey, 800, 0},
		{"span overflow", pubkey, 800, ^uint64(0)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := buildUpdateProvidersBody(tc.pubkey, tc.rate, tc.spanDays); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

// TestBuildUpdateProvidersBodyDeterministicShape pins that a valid call
// succeeds and produces a non-empty BOC — the actual byte content is
// query-id-randomized by design (mirrors PrepareV1DeployData's own
// rand.Int63() query_id), so this checks shape/success, not exact bytes.
func TestBuildUpdateProvidersBodyDeterministicShape(t *testing.T) {
	pubkey := bytes.Repeat([]byte{0xbb}, 32)
	body, err := buildUpdateProvidersBody(pubkey, 800, 192)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	boc := body.ToBOC()
	if len(boc) == 0 {
		t.Fatal("expected a non-empty BOC")
	}
}

func TestParseUpdateProvidersFlagsRequired(t *testing.T) {
	full := func() []string {
		return []string{
			"--contract", "0:" + strings.Repeat("a", 64),
			"--provider-pubkey", strings.Repeat("b", 64),
			"--rate-nano-per-mb-day", "800",
			"--span-days", "192",
		}
	}

	if _, err := parseUpdateProvidersFlags(full()); err != nil {
		t.Fatalf("full args: unexpected error: %v", err)
	}

	cases := []struct {
		name string
		args []string
	}{
		{"missing contract", []string{"--provider-pubkey", strings.Repeat("b", 64), "--rate-nano-per-mb-day", "800", "--span-days", "192"}},
		{"missing provider-pubkey", []string{"--contract", "0:" + strings.Repeat("a", 64), "--rate-nano-per-mb-day", "800", "--span-days", "192"}},
		{"missing rate", []string{"--contract", "0:" + strings.Repeat("a", 64), "--provider-pubkey", strings.Repeat("b", 64), "--span-days", "192"}},
		{"missing span-days", []string{"--contract", "0:" + strings.Repeat("a", 64), "--provider-pubkey", strings.Repeat("b", 64), "--rate-nano-per-mb-day", "800"}},
		{"bad contract", []string{"--contract", "not-an-address", "--provider-pubkey", strings.Repeat("b", 64), "--rate-nano-per-mb-day", "800", "--span-days", "192"}},
		{"bad pubkey", []string{"--contract", "0:" + strings.Repeat("a", 64), "--provider-pubkey", "zz", "--rate-nano-per-mb-day", "800", "--span-days", "192"}},
		{"zero gas-ton", append(full(), "--gas-ton", "0")},
		{"invalid gas-ton", append(full(), "--gas-ton", "not-a-number")},
		{"zero max-spend-ton", append(full(), "--max-spend-ton", "0")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseUpdateProvidersFlags(tc.args); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

// TestParseUpdateProvidersFlagsDefaults pins the 0.05 TON gas / 0.1 TON
// max-spend defaults so a future edit that changes them is a visible,
// deliberate diff rather than a silent behavior change.
func TestParseUpdateProvidersFlagsDefaults(t *testing.T) {
	p, err := parseUpdateProvidersFlags([]string{
		"--contract", "0:" + strings.Repeat("a", 64),
		"--provider-pubkey", strings.Repeat("b", 64),
		"--rate-nano-per-mb-day", "800",
		"--span-days", "192",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.gasNano.String() != "50000000" {
		t.Fatalf("default gasNano = %s, want 50000000 (0.05 TON)", p.gasNano.String())
	}
	if p.maxSpendNano.String() != "100000000" {
		t.Fatalf("default maxSpendNano = %s, want 100000000 (0.1 TON)", p.maxSpendNano.String())
	}
	if !p.testnet {
		t.Fatal("expected testnet=true by default (no --mainnet)")
	}
}

// TestParseUpdateProvidersFlagsMaxSpendGuardIsCheckedAtRunTime documents
// that gas-vs-max-spend is validated in runUpdateProviders (network-touching,
// since it also checks on-chain state first), not in the pure flag parser —
// parseUpdateProvidersFlags accepts a --gas-ton that exceeds --max-spend-ton
// syntactically; this mirrors deploy's max-spend guard placement (buildDeploy,
// not parseDeployFlagSet) and is intentional, not an oversight.
func TestParseUpdateProvidersFlagsMaxSpendGuardIsCheckedAtRunTime(t *testing.T) {
	p, err := parseUpdateProvidersFlags([]string{
		"--contract", "0:" + strings.Repeat("a", 64),
		"--provider-pubkey", strings.Repeat("b", 64),
		"--rate-nano-per-mb-day", "800",
		"--span-days", "192",
		"--gas-ton", "5",
		"--max-spend-ton", "0.1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.gasNano.Cmp(p.maxSpendNano) <= 0 {
		t.Fatal("test setup invalid: expected gasNano > maxSpendNano to exercise the run-time guard path")
	}
}
