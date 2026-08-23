package main

import (
	"bytes"
	"context"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/xssnick/tonutils-go/address"
)

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

// TestRunDeployOffline exercises the FULL `deploy` subcommand end to end —
// flag parsing, resolveDeployParams, buildDeploy, and stdout formatting —
// entirely offline via the --size-bytes/--piece-size/--merkle-hash bypass
// (see resolveDeployParams), so it never touches the network.
func TestRunDeployOffline(t *testing.T) {
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
