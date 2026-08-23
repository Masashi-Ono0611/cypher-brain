package main

import (
	"strings"
	"testing"
)

func TestParseStatusFlagsHappyPath(t *testing.T) {
	p, err := parseStatusFlags([]string{"--contract", "0:" + strings.Repeat("c", 64)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.contract.Workchain() != 0 {
		t.Fatalf("workchain = %d, want 0", p.contract.Workchain())
	}
	if !p.testnet {
		t.Fatal("expected testnet=true by default")
	}
}

func TestParseStatusFlagsMainnet(t *testing.T) {
	p, err := parseStatusFlags([]string{"--contract", "0:" + strings.Repeat("c", 64), "--mainnet"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.testnet {
		t.Fatal("expected testnet=false with --mainnet")
	}
}

func TestParseStatusFlagsAllowsWorkchainMinusOne(t *testing.T) {
	p, err := parseStatusFlags([]string{"--contract", "-1:" + strings.Repeat("c", 64)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.contract.Workchain() != -1 {
		t.Fatalf("workchain = %d, want -1", p.contract.Workchain())
	}
}

func TestParseStatusFlagsErrors(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"missing contract", nil},
		{"empty contract", []string{"--contract", ""}},
		{"malformed contract", []string{"--contract", "not-an-address"}},
		{"extra args", []string{"--contract", "0:" + strings.Repeat("c", 64), "extra"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseStatusFlags(tc.args); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

func TestStateVerdict(t *testing.T) {
	cases := map[string]string{
		"nonexist": "NOT deployed",
		"uninit":   "NOT deployed",
		"active":   "deployed",
		"frozen":   "frozen",
	}
	for status, wantSubstr := range cases {
		got := stateVerdict(status)
		if !strings.Contains(got, wantSubstr) {
			t.Errorf("stateVerdict(%q) = %q, want it to contain %q", status, got, wantSubstr)
		}
	}
	if !strings.Contains(stateVerdict("something-new"), "unrecognized") {
		t.Errorf("stateVerdict of an unknown status should say so")
	}
}

func TestTonapiBase(t *testing.T) {
	if tonapiBase(true) != tonapiTestnetBase {
		t.Fatalf("tonapiBase(true) = %s, want %s", tonapiBase(true), tonapiTestnetBase)
	}
	if tonapiBase(false) != tonapiMainnetBase {
		t.Fatalf("tonapiBase(false) = %s, want %s", tonapiBase(false), tonapiMainnetBase)
	}
}
