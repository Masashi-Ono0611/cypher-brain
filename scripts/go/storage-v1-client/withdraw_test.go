package main

import (
	"bytes"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tvm/cell"
)

const opWithdrawOwner = 0x61fff683

// fixedWithdrawParams reuses the exact same state-field values as
// fixedDeployParams (deploy_test.go) — bagID/merkleHash/dataSizeBytes/
// pieceSize/owner — so the derived contract address matches what `deploy`
// would have produced for this bag/owner. --contract is computed once via
// buildDeploy in TestMain-adjacent helper below rather than hardcoded, so a
// change to fixedDeployParams can't silently desync the two tests.
func fixedWithdrawParams(t *testing.T, contractAddr *address.Address) withdrawParams {
	t.Helper()
	return withdrawParams{
		contract:      contractAddr,
		bagID:         bytes.Repeat([]byte{0xaa}, 32),
		merkleHash:    bytes.Repeat([]byte{0xdd}, 32),
		dataSizeBytes: 500_000_000,
		pieceSize:     131072,
		owner:         address.NewAddress(0, 0, bytes.Repeat([]byte{0xcc}, 32)),
		gasNano:       big.NewInt(50_000_000),  // 0.05 TON
		maxSpendNano:  big.NewInt(100_000_000), // 0.1 TON — plenty of headroom
		testnet:       true,
	}
}

// deployedContractAddrForWithdrawTests derives the same contract address
// buildDeploy would produce for fixedDeployParams's state fields, without
// depending on buildDeploy's own success (so this test file stays
// self-contained even if deploy_test.go changes shape).
func deployedContractAddrForWithdrawTests(t *testing.T) *address.Address {
	t.Helper()
	res, err := buildDeploy(fixedDeployParams(t))
	if err != nil {
		t.Fatalf("buildDeploy(fixedDeployParams): %v", err)
	}
	return res.contractAddr
}

// TestBuildWithdrawMatchesDeployAddress is the core positive case: given the
// SAME state fields (bag id, merkle hash, size, piece size, owner) `deploy`
// used to produce a contract address, buildWithdraw's independent
// re-derivation (via contract.PrepareWithdrawalRequest, the same upstream
// function) must agree — this is the exact address-mismatch guardrail
// buildWithdraw enforces, exercised on its "should succeed" side.
func TestBuildWithdrawMatchesDeployAddress(t *testing.T) {
	contractAddr := deployedContractAddrForWithdrawTests(t)
	p := fixedWithdrawParams(t, contractAddr)

	res, err := buildWithdraw(p)
	if err != nil {
		t.Fatalf("buildWithdraw: %v", err)
	}
	if len(res.bodyBOC) == 0 {
		t.Fatal("buildWithdraw returned empty bodyBOC")
	}

	// Codex review finding (Suggestion): decode the body and confirm it is
	// EXACTLY op::withdraw_owner (0x61fff683) — a nonempty body alone
	// doesn't rule out building the wrong message for this operation.
	bodyCell, err := cell.FromBOC(res.bodyBOC)
	if err != nil {
		t.Fatalf("cell.FromBOC(bodyBOC): %v", err)
	}
	slice, err := bodyCell.BeginParse()
	if err != nil {
		t.Fatalf("bodyCell.BeginParse(): %v", err)
	}
	op, err := slice.LoadUInt(32)
	if err != nil {
		t.Fatalf("load opcode: %v", err)
	}
	if op != opWithdrawOwner {
		t.Fatalf("body opcode = 0x%x, want withdraw_owner 0x%x", op, opWithdrawOwner)
	}

	// Codex review finding (Suggestion): also assert the deeplink's
	// destination and amount match what was requested, not just its prefix.
	wantDest := p.contract.Copy().Bounce(true).Testnet(p.testnet).String()
	wantAmount := fmt.Sprintf("amount=%s", p.gasNano.String())
	if !strings.HasPrefix(res.deeplink, "ton://transfer/"+wantDest+"?") {
		t.Fatalf("deeplink destination mismatch: got %s, want prefix ton://transfer/%s?", res.deeplink, wantDest)
	}
	if !strings.Contains(res.deeplink, wantAmount) {
		t.Fatalf("deeplink missing expected %s: %s", wantAmount, res.deeplink)
	}
	if strings.Contains(res.deeplink, "init=") {
		t.Fatalf("withdraw deeplink must NOT include init= (no new StateInit, contract already deployed): %s", res.deeplink)
	}
}

// TestBuildWithdrawRejectsAddressMismatch is the RED half of the guardrail
// this whole file exists for: buildWithdraw must refuse (not silently build
// a deeplink) when any state field doesn't match --contract's actual
// derivation. Mirrors TestBuildDeployAddressDependsOnStateFieldsOnly's
// per-field mutation style, but asserts a *guardError* refusal rather than
// "the address changed" — this test would have caught the exact class of
// mistake (wrong bag-shape flags describing a DIFFERENT contract than
// --contract) that this guard was added to prevent.
func TestBuildWithdrawRejectsAddressMismatch(t *testing.T) {
	contractAddr := deployedContractAddrForWithdrawTests(t)

	mustReject := func(name string, mutate func(p *withdrawParams)) {
		t.Helper()
		p := fixedWithdrawParams(t, contractAddr)
		mutate(&p)
		_, err := buildWithdraw(p)
		if err == nil {
			t.Fatalf("%s: buildWithdraw succeeded, want a mismatch refusal", name)
		}
		if _, ok := err.(*guardError); !ok {
			t.Fatalf("%s: buildWithdraw returned %v (%T), want a *guardError", name, err, err)
		}
	}

	mustReject("wrong bagID", func(p *withdrawParams) {
		p.bagID = bytes.Repeat([]byte{0xee}, 32)
	})
	mustReject("wrong merkleHash", func(p *withdrawParams) {
		p.merkleHash = bytes.Repeat([]byte{0xee}, 32)
	})
	mustReject("wrong dataSizeBytes", func(p *withdrawParams) {
		p.dataSizeBytes = 999_999_999
	})
	mustReject("wrong pieceSize", func(p *withdrawParams) {
		p.pieceSize = 65536
	})
	mustReject("wrong owner", func(p *withdrawParams) {
		p.owner = address.NewAddress(0, 0, bytes.Repeat([]byte{0xff}, 32))
	})
}

// TestBuildWithdrawGasGuard exercises the --max-spend-ton style refusal,
// mirroring checkUpdateProvidersGasGuard's own coverage — buildWithdraw must
// refuse rather than silently attach more gas than the operator capped.
func TestBuildWithdrawGasGuard(t *testing.T) {
	contractAddr := deployedContractAddrForWithdrawTests(t)
	p := fixedWithdrawParams(t, contractAddr)
	p.gasNano = big.NewInt(200_000_000)      // 0.2 TON
	p.maxSpendNano = big.NewInt(100_000_000) // 0.1 TON cap — gas exceeds it

	_, err := buildWithdraw(p)
	if err == nil {
		t.Fatal("buildWithdraw succeeded, want a max-spend refusal")
	}
	if _, ok := err.(*guardError); !ok {
		t.Fatalf("buildWithdraw returned %v (%T), want a *guardError", err, err)
	}
}

// TestBuildWithdrawFieldLengthValidation pins the same 32-byte length
// checks buildDeploy enforces for bagID/merkleHash, and the pieceSize>0
// check — a defensive test since a caller could otherwise pass a
// zero-length or wrong-length slice through the pure buildWithdraw path
// (parseWithdrawFlags enforces this too, but that's the network-adjacent
// half; this pins the pure core independently, same split as deploy_test.go).
func TestBuildWithdrawFieldLengthValidation(t *testing.T) {
	contractAddr := deployedContractAddrForWithdrawTests(t)

	cases := []struct {
		name   string
		mutate func(p *withdrawParams)
	}{
		{"short bagID", func(p *withdrawParams) { p.bagID = p.bagID[:16] }},
		{"short merkleHash", func(p *withdrawParams) { p.merkleHash = p.merkleHash[:16] }},
		{"zero dataSizeBytes", func(p *withdrawParams) { p.dataSizeBytes = 0 }},
		{"zero pieceSize", func(p *withdrawParams) { p.pieceSize = 0 }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := fixedWithdrawParams(t, contractAddr)
			c.mutate(&p)
			if _, err := buildWithdraw(p); err == nil {
				t.Fatalf("%s: buildWithdraw succeeded, want a validation error", c.name)
			}
		})
	}
}
