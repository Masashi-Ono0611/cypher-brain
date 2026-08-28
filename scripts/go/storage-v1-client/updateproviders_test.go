package main

import (
	"bytes"
	"math/big"
	"strings"
	"testing"

	"github.com/xssnick/tonutils-go/tvm/cell"
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

// decodedProviderEntry pulls the opcode, dict key, and the two ProviderV1
// body fields (MaxSpan, PricePerMBDay) back out of a modify_providers body —
// used below to prove buildUpdateProvidersBody's hand-copied dict-building
// logic actually encodes what it claims to, not just that it produces SOME
// non-empty cell (Codex review finding: a shape-only check would pass even
// if the pubkey were dropped or written to the wrong field).
type decodedProviderEntry struct {
	opcode  uint64
	key     []byte
	maxSpan uint64
	rate    *big.Int
}

func decodeSingleProviderBody(t *testing.T, body *cell.Cell, expectKey []byte) decodedProviderEntry {
	t.Helper()
	s, err := body.BeginParse()
	if err != nil {
		t.Fatalf("BeginParse: %v", err)
	}
	opcode, err := s.LoadUInt(32)
	if err != nil {
		t.Fatalf("LoadUInt(opcode): %v", err)
	}
	if _, err := s.LoadUInt(64); err != nil { // query_id — randomized, not compared
		t.Fatalf("LoadUInt(query_id): %v", err)
	}
	dict, err := s.LoadDict(256)
	if err != nil {
		t.Fatalf("LoadDict: %v", err)
	}
	val, err := dict.LoadValueByIntKey(new(big.Int).SetBytes(expectKey))
	if err != nil {
		t.Fatalf("LoadValueByIntKey(%x): %v — the dict does not contain the expected key at all", expectKey, err)
	}
	maxSpan, err := val.LoadUInt(32)
	if err != nil {
		t.Fatalf("LoadUInt(MaxSpan): %v", err)
	}
	rate, err := val.LoadBigCoins()
	if err != nil {
		t.Fatalf("LoadBigCoins(PricePerMBDay): %v", err)
	}
	return decodedProviderEntry{opcode: opcode, key: expectKey, maxSpan: maxSpan, rate: rate}
}

// TestBuildUpdateProvidersBodySemanticContents proves (not just asserts) that
// buildUpdateProvidersBody encodes the exact pubkey/rate/span it was given,
// by decoding the body back and checking every field — closing the gap the
// shape-only test above leaves.
func TestBuildUpdateProvidersBodySemanticContents(t *testing.T) {
	pubkey := bytes.Repeat([]byte{0xbb}, 32)
	const rateNanoPerMB = 800
	const spanDays = 192

	body, err := buildUpdateProvidersBody(pubkey, rateNanoPerMB, spanDays)
	if err != nil {
		t.Fatalf("buildUpdateProvidersBody: %v", err)
	}
	got := decodeSingleProviderBody(t, body, pubkey)

	if got.opcode != 0x3dc680ae {
		t.Errorf("opcode = 0x%x, want 0x3dc680ae (modify_providers)", got.opcode)
	}
	if got.maxSpan != spanDays*86400 {
		t.Errorf("MaxSpan = %d, want %d (spanDays*86400)", got.maxSpan, spanDays*86400)
	}
	// rateNanoPerMB is already in nanoTON (tlb.FromNanoTONU takes a value
	// already denominated in nanoTON, unlike tlb.FromTON which takes whole
	// TON) — this test itself first asserted a wrong x1e9 expectation here
	// and caught it failing against the real implementation, which is
	// correct; confirms buildUpdateProvidersBody does NOT introduce a
	// TON/nanoTON scaling bug.
	wantRate := big.NewInt(rateNanoPerMB)
	if got.rate.Cmp(wantRate) != 0 {
		t.Errorf("rate = %s nanoTON, want %s nanoTON", got.rate, wantRate)
	}
}

// TestUpdateProvidersBodyMatchesDeployBody is the golden compatibility test
// Codex flagged as missing: it proves buildUpdateProvidersBody's hand-copied
// dict/body logic stays byte-compatible with contract.PrepareV1DeployData's
// OWN body construction (called via buildDeploy) for the identical
// conceptual provider inputs — so a future upstream layout change to either
// path, or a typo introduced into the hand copy, shows up as a test failure
// instead of silently desynchronizing the two.
func TestUpdateProvidersBodyMatchesDeployBody(t *testing.T) {
	pubkey := bytes.Repeat([]byte{0x77}, 32)
	const rateNanoPerMB = 12345
	const spanDays = 30

	dp := fixedDeployParams(t)
	dp.providerPubkey = pubkey
	dp.rateNanoPerMB = rateNanoPerMB
	dp.spanDays = spanDays
	deployRes, err := buildDeploy(dp)
	if err != nil {
		t.Fatalf("buildDeploy: %v", err)
	}

	repairBody, err := buildUpdateProvidersBody(pubkey, rateNanoPerMB, spanDays)
	if err != nil {
		t.Fatalf("buildUpdateProvidersBody: %v", err)
	}

	deployBOC := deployRes.bodyBOC
	deployCell, err := cell.FromBOC(deployBOC)
	if err != nil {
		t.Fatalf("cell.FromBOC(deploy body): %v", err)
	}

	deployDecoded := decodeSingleProviderBody(t, deployCell, pubkey)
	repairDecoded := decodeSingleProviderBody(t, repairBody, pubkey)

	if deployDecoded.opcode != repairDecoded.opcode {
		t.Errorf("opcode mismatch: deploy=0x%x repair=0x%x", deployDecoded.opcode, repairDecoded.opcode)
	}
	if deployDecoded.maxSpan != repairDecoded.maxSpan {
		t.Errorf("MaxSpan mismatch: deploy=%d repair=%d", deployDecoded.maxSpan, repairDecoded.maxSpan)
	}
	if deployDecoded.rate.Cmp(repairDecoded.rate) != 0 {
		t.Errorf("rate mismatch: deploy=%s repair=%s", deployDecoded.rate, repairDecoded.rate)
	}
}

func TestCheckUpdateProvidersGasGuard(t *testing.T) {
	if err := checkUpdateProvidersGasGuard(big.NewInt(50_000_000), big.NewInt(100_000_000)); err != nil {
		t.Fatalf("gas within limit: unexpected error: %v", err)
	}
	err := checkUpdateProvidersGasGuard(big.NewInt(5_000_000_000), big.NewInt(100_000_000))
	if err == nil {
		t.Fatal("gas over limit: expected an error, got nil")
	}
	if _, ok := err.(*guardError); !ok {
		t.Fatalf("expected *guardError, got %T: %v", err, err)
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

// TestParseUpdateProvidersFlagsReportsAllMissingRequiredFlags pins the fix
// for the "reports missing required flags one at a time" UX issue.
func TestParseUpdateProvidersFlagsReportsAllMissingRequiredFlags(t *testing.T) {
	_, err := parseUpdateProvidersFlags(nil)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	msg := err.Error()
	for _, want := range []string{
		"--contract <raw-addr>",
		"--provider-pubkey <64hex>",
		"--rate-nano-per-mb-day <int>",
		"--span-days <int>",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not mention missing flag %q", msg, want)
		}
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
// that gas-vs-max-spend is validated in runUpdateProviders via
// checkUpdateProvidersGasGuard (a separate, network-free step that
// runUpdateProviders runs BEFORE the on-chain state check — see updateproviders.go
// — so a bad --gas-ton fails fast without a tonapi round trip), not in the
// pure flag parser — parseUpdateProvidersFlags accepts a --gas-ton that
// exceeds --max-spend-ton syntactically; this mirrors deploy's max-spend
// guard placement (buildDeploy, not parseDeployFlagSet) and is intentional,
// not an oversight.
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
