package main

import (
	"bytes"
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xssnick/tonutils-go/address"
)

// withMockTonapi points tonapiBase() (status.go) at a local httptest.Server for the
// duration of the calling test, so runDeploy's issue #638 already-active check (below)
// gets a real HTTP round trip without ever reaching the actual tonapi.io — restores the
// override on cleanup so it cannot leak into any other test in this package.
func withMockTonapi(t *testing.T, status string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "balance": 0})
	}))
	t.Cleanup(srv.Close)
	prev := tonapiBaseOverride
	tonapiBaseOverride = srv.URL
	t.Cleanup(func() { tonapiBaseOverride = prev })
}

func fixedDeployParams(t *testing.T) deployParams {
	t.Helper()
	return deployParams{
		bagID:          bytes.Repeat([]byte{0xaa}, 32),
		merkleHash:     bytes.Repeat([]byte{0xdd}, 32),
		dataSizeBytes:  500_000_000,
		pieceSize:      131072,
		owner:          address.NewAddress(0, 0, bytes.Repeat([]byte{0xcc}, 32)),
		providerPubkey: bytes.Repeat([]byte{0xbb}, 32),
		rateNanoPerMB:  1000,
		spanDays:       7,
		maxSpendNano:   big.NewInt(1_000_000_000), // 1 TON — plenty of headroom
		testnet:        true,
	}
}

// TestBuildDeployDeterministic pins that calling buildDeploy twice with
// identical inputs yields the identical contract address — a basic sanity
// check before the more interesting "which fields the address depends on"
// test below.
func TestBuildDeployDeterministic(t *testing.T) {
	p := fixedDeployParams(t)
	r1, err := buildDeploy(p)
	if err != nil {
		t.Fatalf("buildDeploy #1: %v", err)
	}
	r2, err := buildDeploy(p)
	if err != nil {
		t.Fatalf("buildDeploy #2: %v", err)
	}
	if r1.contractAddr.String() != r2.contractAddr.String() {
		t.Fatalf("contract address not deterministic: %s vs %s", r1.contractAddr.String(), r2.contractAddr.String())
	}
}

// TestBuildDeployAddressDependsOnStateFieldsOnly exercises the field mapping
// into contract.PrepareV1DeployData (the actual upstream function — see
// main.go header): the contract address must change when any STATE field
// (bag id / merkle hash / data size / piece size / owner) changes, and must
// NOT change when only the modify_providers BODY fields (provider pubkey,
// rate, span) change — since those live in the deploy message body, not in
// the StateInit data cell that determines the address (verified by reading
// xssnick/tonutils-storage-provider pkg/contract/v1.go PrepareV1DeployData:
// ActiveProviders is never set in `data`, and contractAddr is derived from
// `data` + code only — confirmed 2026-08-23 by a real repair incident: the
// SAME live contract address stayed valid after correcting the provider
// list, since providers never touched the address in the first place).
// Getting this positional-argument mapping wrong (e.g. swapping dataSize/
// pieceSize, or torrentHash/merkleHash) is exactly the class of bug this
// test is designed to catch, since such a swap would either change addresses
// that should stay fixed, or fail to change ones that should move.
func TestBuildDeployAddressDependsOnStateFieldsOnly(t *testing.T) {
	base := fixedDeployParams(t)
	baseRes, err := buildDeploy(base)
	if err != nil {
		t.Fatalf("buildDeploy(base): %v", err)
	}
	baseAddr := baseRes.contractAddr.String()

	mustDiffer := func(name string, mutate func(p *deployParams)) {
		t.Helper()
		p := fixedDeployParams(t)
		mutate(&p)
		r, err := buildDeploy(p)
		if err != nil {
			t.Fatalf("%s: buildDeploy: %v", name, err)
		}
		if r.contractAddr.String() == baseAddr {
			t.Errorf("%s: contract address unchanged (%s) — expected it to depend on this field", name, baseAddr)
		}
	}

	mustDiffer("bagID", func(p *deployParams) { p.bagID = bytes.Repeat([]byte{0xee}, 32) })
	mustDiffer("merkleHash", func(p *deployParams) { p.merkleHash = bytes.Repeat([]byte{0xff}, 32) })
	mustDiffer("dataSizeBytes", func(p *deployParams) { p.dataSizeBytes = 999 })
	mustDiffer("pieceSize", func(p *deployParams) { p.pieceSize = 4096 })
	mustDiffer("owner", func(p *deployParams) { p.owner = address.NewAddress(0, 0, bytes.Repeat([]byte{0x11}, 32)) })

	mustMatch := func(name string, mutate func(p *deployParams)) {
		t.Helper()
		p := fixedDeployParams(t)
		mutate(&p)
		r, err := buildDeploy(p)
		if err != nil {
			t.Fatalf("%s: buildDeploy: %v", name, err)
		}
		if r.contractAddr.String() != baseAddr {
			t.Errorf("%s: contract address changed (%s -> %s) — expected it to be independent of this field", name, baseAddr, r.contractAddr.String())
		}
	}

	mustMatch("providerPubkey", func(p *deployParams) { p.providerPubkey = bytes.Repeat([]byte{0x22}, 32) })
	mustMatch("rateNanoPerMB", func(p *deployParams) { p.rateNanoPerMB = 99999 })
	mustMatch("spanDays", func(p *deployParams) { p.spanDays = 1 })
}

func TestBuildDeployMaxSpendGuard(t *testing.T) {
	p := fixedDeployParams(t)
	p.maxSpendNano = big.NewInt(1) // far below the computed amount
	_, err := buildDeploy(p)
	if err == nil {
		t.Fatal("expected a guard error, got nil")
	}
	if _, ok := err.(*guardError); !ok {
		t.Fatalf("expected *guardError, got %T: %v", err, err)
	}
}

func TestBuildDeployValidation(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(p *deployParams)
	}{
		{"short bagID", func(p *deployParams) { p.bagID = p.bagID[:31] }},
		{"short merkleHash", func(p *deployParams) { p.merkleHash = p.merkleHash[:31] }},
		{"short providerPubkey", func(p *deployParams) { p.providerPubkey = p.providerPubkey[:31] }},
		{"zero rate", func(p *deployParams) { p.rateNanoPerMB = 0 }},
		{"zero span", func(p *deployParams) { p.spanDays = 0 }},
		{"zero size", func(p *deployParams) { p.dataSizeBytes = 0 }},
		{"zero piece size", func(p *deployParams) { p.pieceSize = 0 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := fixedDeployParams(t)
			tc.mutate(&p)
			if _, err := buildDeploy(p); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

// TestParseDeployFlagSetRequiresEverything checks that resolveDeployParams
// rejects a missing required flag WITHOUT ever reaching the network (the
// seeder SSH call) — every one of these cases must fail during pure
// validation, before fetchSeederDetails could be called.
func TestResolveDeployParamsRequiredFlags(t *testing.T) {
	full := func() *deployFlags {
		return &deployFlags{
			bagIDHex:          strings.Repeat("a", 64),
			providerPubkeyRaw: strings.Repeat("b", 64),
			ownerRaw:          "0:" + strings.Repeat("c", 64),
			rateRaw:           "1000",
			spanDaysRaw:       "7",
			sizeBytesRaw:      "500000000",
			pieceSizeRaw:      "131072",
			merkleHashRaw:     strings.Repeat("d", 64),
			maxSpendTon:       "0.5",
		}
	}

	cases := []struct {
		name   string
		mutate func(f *deployFlags)
	}{
		{"missing bag-id", func(f *deployFlags) { f.bagIDHex = "" }},
		{"missing provider-pubkey", func(f *deployFlags) { f.providerPubkeyRaw = "" }},
		{"missing owner", func(f *deployFlags) { f.ownerRaw = "" }},
		{"missing rate", func(f *deployFlags) { f.rateRaw = "" }},
		{"missing span-days", func(f *deployFlags) { f.spanDaysRaw = "" }},
		{"invalid bag-id", func(f *deployFlags) { f.bagIDHex = "not-hex" }},
		{"provider-pubkey too short", func(f *deployFlags) { f.providerPubkeyRaw = "bb" }},
		{"provider-pubkey not hex", func(f *deployFlags) { f.providerPubkeyRaw = strings.Repeat("z", 64) }},
		{"only size-bytes given", func(f *deployFlags) { f.pieceSizeRaw = ""; f.merkleHashRaw = "" }},
		{"only piece-size given", func(f *deployFlags) { f.sizeBytesRaw = ""; f.merkleHashRaw = "" }},
		{"invalid max-spend-ton", func(f *deployFlags) { f.maxSpendTon = "not-a-number" }},
		{"zero max-spend-ton", func(f *deployFlags) { f.maxSpendTon = "0" }},
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := full()
			tc.mutate(f)
			if _, err := resolveDeployParams(ctx, f); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

// TestResolveDeployParamsReportsAllMissingRequiredFlags pins the fix for the
// "reports missing required flags one at a time" UX issue: an operator
// running `deploy` with every required flag omitted should see all of them
// listed in the single error, not just the first one checked.
func TestResolveDeployParamsReportsAllMissingRequiredFlags(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	_, err := resolveDeployParams(ctx, &deployFlags{maxSpendTon: "0.5"})
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	msg := err.Error()
	for _, want := range []string{
		"--bag-id <64hex>",
		"--provider-pubkey <64hex>",
		"--owner <raw-addr>",
		"--rate-nano-per-mb-day <int>",
		"--span-days <int>",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not mention missing flag %q", msg, want)
		}
	}
}

// TestRunDeployOffline exercises the FULL `deploy` subcommand end to end —
// flag parsing, resolveDeployParams, buildDeploy, the issue #638 already-active
// check, and stdout formatting. Never touches the real network: the seeder lookup
// is bypassed via --size-bytes/--piece-size/--merkle-hash (see resolveDeployParams),
// and the on-chain state check hits a local httptest.Server (withMockTonapi) rather
// than tonapi.io, reporting 'nonexist' — a genuinely fresh, never-deployed address —
// so the deploy link is still offered, exactly like before issue #638's fix.
func TestRunDeployOffline(t *testing.T) {
	withMockTonapi(t, "nonexist")
	args := []string{
		"--bag-id", strings.Repeat("a", 64),
		"--provider-pubkey", strings.Repeat("b", 64),
		"--owner", "0:" + strings.Repeat("c", 64),
		"--rate-nano-per-mb-day", "1000",
		"--span-days", "7",
		"--size-bytes", "500000000",
		"--piece-size", "131072",
		"--merkle-hash", strings.Repeat("d", 64),
		"--max-spend-ton", "5",
	}

	var stdout bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := runDeploy(ctx, args, &stdout); err != nil {
		t.Fatalf("runDeploy: %v", err)
	}

	out := stdout.String()
	wantProviderPubkey := "storage-v1-client notify --provider-pubkey " + strings.Repeat("b", 64) + " --contract"
	for _, want := range []string{
		"== deploy ==",
		"contract addr:",
		"deeplink:       ton://transfer/",
		"storage-v1-client status --contract",
		wantProviderPubkey,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("runDeploy output missing %q; full output:\n%s", want, out)
		}
	}
}

// deployArgsFixture returns the SAME deploy args as TestRunDeployOffline's, factored
// out so the issue #638 tests below can reuse the identical bagID/owner/etc — the
// StorageV1 contract address deploy.go/buildDeploy derives depends ONLY on those
// fields (see runDeploy's own comment), so any test below deriving a DIFFERENT
// pubkey/rate/span with these SAME args is exercising the exact real-world shape
// issue #638 describes: a retry that picks a different provider still targets the
// identical contract.
func deployArgsFixture(providerPubkey, rate string) []string {
	return []string{
		"--bag-id", strings.Repeat("a", 64),
		"--provider-pubkey", providerPubkey,
		"--owner", "0:" + strings.Repeat("c", 64),
		"--rate-nano-per-mb-day", rate,
		"--span-days", "7",
		"--size-bytes", "500000000",
		"--piece-size", "131072",
		"--merkle-hash", strings.Repeat("d", 64),
		"--max-spend-ton", "5",
	}
}

// TestRunDeployRefusesAlreadyActiveContract is issue #638's core positive control for
// the Go `deploy` subcommand: once tonapi reports the derived contract address as
// 'active', deploy must REFUSE to offer another deploy link rather than let the
// operator sign and pay the storage cost a second time — even though this run picked
// a DIFFERENT --provider-pubkey/--rate-nano-per-mb-day than whatever the original
// deploy used (the address does not depend on either, per buildDeploy's own field
// mapping — see TestBuildDeployAddressDependsOnStateFieldsOnly).
func TestRunDeployRefusesAlreadyActiveContract(t *testing.T) {
	withMockTonapi(t, "active")
	args := deployArgsFixture(strings.Repeat("e", 64), "9999") // different provider/rate than the offline test above — SAME contract address

	var stdout bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := runDeploy(ctx, args, &stdout)
	if err == nil {
		t.Fatal("expected runDeploy to refuse an already-active contract, got nil error")
	}
	if _, ok := err.(*guardError); !ok {
		t.Fatalf("expected *guardError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), "ALREADY ACTIVE") {
		t.Fatalf("refusal message missing 'ALREADY ACTIVE': %v", err)
	}
	if !strings.Contains(err.Error(), "update-providers") {
		t.Fatalf("refusal message should point the operator at update-providers instead: %v", err)
	}
	if strings.Contains(stdout.String(), "== deploy ==") {
		t.Fatalf("a deploy link was printed despite the contract already being active:\n%s", stdout.String())
	}
}

// TestRunDeployProceedsForNotYetActiveStates proves the guard above is scoped to
// 'active' specifically, not "anything but nonexist" — a contract that is funded but
// not yet running ('uninit', the brief window right after a broadcast lands) or that
// was never deployed at all ('nonexist') must still get a normal deploy link.
func TestRunDeployProceedsForNotYetActiveStates(t *testing.T) {
	for _, status := range []string{"nonexist", "uninit"} {
		t.Run(status, func(t *testing.T) {
			withMockTonapi(t, status)
			args := deployArgsFixture(strings.Repeat("f", 64), "1234")

			var stdout bytes.Buffer
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()

			if err := runDeploy(ctx, args, &stdout); err != nil {
				t.Fatalf("runDeploy: %v", err)
			}
			if !strings.Contains(stdout.String(), "== deploy ==") {
				t.Fatalf("expected a normal deploy link for status %q, got:\n%s", status, stdout.String())
			}
		})
	}
}

// TestRunDeployRefusesWhenStateCheckFails: unlike ton-provider.ts's unattended
// auto-sign path (which fails OPEN on a check error so a transient tonapi hiccup
// cannot wedge an automated nightly push), this manual, human-reviewed CLI fails
// CLOSED — matching update-providers.go's own established precedent for the same
// kind of tonapi read failure (runUpdateProviders: "could not fetch account state
// from tonapi — refusing ..."). An operator who cannot confirm the address is safe
// to fund should have to re-check, not silently get a deploy link anyway.
func TestRunDeployRefusesWhenStateCheckFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	prev := tonapiBaseOverride
	tonapiBaseOverride = srv.URL
	defer func() { tonapiBaseOverride = prev }()

	args := deployArgsFixture(strings.Repeat("f", 64), "1234")
	var stdout bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := runDeploy(ctx, args, &stdout)
	if err == nil {
		t.Fatal("expected runDeploy to refuse when the on-chain state check fails, got nil error")
	}
	if strings.Contains(stdout.String(), "== deploy ==") {
		t.Fatalf("a deploy link was printed despite the state check failing:\n%s", stdout.String())
	}
}

func TestRunDeployOfflineGuardExitsAsGuardError(t *testing.T) {
	args := []string{
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

	var stdout bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := runDeploy(ctx, args, &stdout)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if _, ok := err.(*guardError); !ok {
		t.Fatalf("expected *guardError, got %T: %v", err, err)
	}
}
