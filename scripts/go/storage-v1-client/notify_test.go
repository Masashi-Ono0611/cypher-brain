package main

import (
	"strings"
	"testing"
	"time"
)

func TestParseNotifyFlagsHappyPath(t *testing.T) {
	hex64 := strings.Repeat("b", 64)
	p, err := parseNotifyFlags([]string{
		"--provider", "0:" + hex64,
		"--contract", "0:" + strings.Repeat("c", 64),
		"--byte-to-proof", "42",
		"--timeout", "10",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.provider.Workchain() != 0 {
		t.Fatalf("provider workchain = %d, want 0", p.provider.Workchain())
	}
	if p.byteToProof != 42 {
		t.Fatalf("byteToProof = %d, want 42", p.byteToProof)
	}
	if p.timeout != 10*time.Second {
		t.Fatalf("timeout = %s, want 10s", p.timeout)
	}
	if !p.testnet {
		t.Fatal("expected testnet=true by default (no --mainnet)")
	}
}

func TestParseNotifyFlagsDefaults(t *testing.T) {
	p, err := parseNotifyFlags([]string{
		"--provider", "0:" + strings.Repeat("b", 64),
		"--contract", "0:" + strings.Repeat("c", 64),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.byteToProof != 0 {
		t.Fatalf("default byteToProof = %d, want 0 (always in-range regardless of bag size)", p.byteToProof)
	}
	if p.timeout != 20*time.Second {
		t.Fatalf("default timeout = %s, want 20s", p.timeout)
	}
}

func TestParseNotifyFlagsMainnet(t *testing.T) {
	p, err := parseNotifyFlags([]string{
		"--provider", "0:" + strings.Repeat("b", 64),
		"--contract", "0:" + strings.Repeat("c", 64),
		"--mainnet",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.testnet {
		t.Fatal("expected testnet=false with --mainnet")
	}
}

func TestParseNotifyFlagsErrors(t *testing.T) {
	hex64 := strings.Repeat("b", 64)
	cases := []struct {
		name string
		args []string
	}{
		{"missing provider", []string{"--contract", "0:" + strings.Repeat("c", 64)}},
		{"missing contract", []string{"--provider", "0:" + hex64}},
		{"provider workchain -1", []string{"--provider", "-1:" + hex64, "--contract", "0:" + strings.Repeat("c", 64)}},
		{"contract not raw addr", []string{"--provider", "0:" + hex64, "--contract", "not-an-address"}},
		{"timeout zero", []string{"--provider", "0:" + hex64, "--contract", "0:" + strings.Repeat("c", 64), "--timeout", "0"}},
		{"timeout too large", []string{"--provider", "0:" + hex64, "--contract", "0:" + strings.Repeat("c", 64), "--timeout", "601"}},
		{"extra args", []string{"--provider", "0:" + hex64, "--contract", "0:" + strings.Repeat("c", 64), "extra"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseNotifyFlags(tc.args); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

func TestGlobalConfigURL(t *testing.T) {
	if globalConfigURL(true) != testnetGlobalConfigURL {
		t.Fatalf("globalConfigURL(true) = %s, want %s", globalConfigURL(true), testnetGlobalConfigURL)
	}
	if globalConfigURL(false) != mainnetGlobalConfigURL {
		t.Fatalf("globalConfigURL(false) = %s, want %s", globalConfigURL(false), mainnetGlobalConfigURL)
	}
}

// TestNotifyProviderRejectsBadKeyLength is the one part of notifyProvider we
// can exercise without a network: the length guard runs before any ADNL/DHT
// setup.
func TestNotifyProviderRejectsBadKeyLength(t *testing.T) {
	_, err := notifyProvider(nil, []byte{1, 2, 3}, nil, 0, mainnetGlobalConfigURL, time.Second)
	if err == nil {
		t.Fatal("expected an error for a short provider key, got nil")
	}
}
