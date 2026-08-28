package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestParseRatesFlagsHappyPath(t *testing.T) {
	hex64 := strings.Repeat("b", 64)
	p, err := parseRatesFlags([]string{
		"--provider-pubkey", hex64,
		"--size-bytes", "123456",
		"--timeout", "10",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wantPubkey := bytes.Repeat([]byte{0xbb}, 32)
	if !bytes.Equal(p.providerPubkey, wantPubkey) {
		t.Fatalf("providerPubkey = %x, want %x", p.providerPubkey, wantPubkey)
	}
	if p.sizeBytes != 123456 {
		t.Fatalf("sizeBytes = %d, want 123456", p.sizeBytes)
	}
	if p.timeout != 10*time.Second {
		t.Fatalf("timeout = %s, want 10s", p.timeout)
	}
	if !p.testnet {
		t.Fatal("expected testnet=true by default (no --mainnet)")
	}
}

func TestParseRatesFlagsDefaults(t *testing.T) {
	p, err := parseRatesFlags([]string{
		"--provider-pubkey", strings.Repeat("b", 64),
		"--size-bytes", "1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.timeout != 20*time.Second {
		t.Fatalf("default timeout = %s, want 20s", p.timeout)
	}
}

func TestParseRatesFlagsMainnet(t *testing.T) {
	p, err := parseRatesFlags([]string{
		"--provider-pubkey", strings.Repeat("b", 64),
		"--size-bytes", "1",
		"--mainnet",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.testnet {
		t.Fatal("expected testnet=false with --mainnet")
	}
}

func TestParseRatesFlagsErrors(t *testing.T) {
	hex64 := strings.Repeat("b", 64)
	cases := []struct {
		name string
		args []string
	}{
		{"missing provider-pubkey", []string{"--size-bytes", "1"}},
		{"missing size-bytes", []string{"--provider-pubkey", hex64}},
		{"provider-pubkey too short", []string{"--provider-pubkey", "bb", "--size-bytes", "1"}},
		{"provider-pubkey not hex", []string{"--provider-pubkey", strings.Repeat("z", 64), "--size-bytes", "1"}},
		{"size-bytes zero", []string{"--provider-pubkey", hex64, "--size-bytes", "0"}},
		{"size-bytes not a number", []string{"--provider-pubkey", hex64, "--size-bytes", "abc"}},
		{"timeout zero", []string{"--provider-pubkey", hex64, "--size-bytes", "1", "--timeout", "0"}},
		{"timeout too large", []string{"--provider-pubkey", hex64, "--size-bytes", "1", "--timeout", "601"}},
		{"extra args", []string{"--provider-pubkey", hex64, "--size-bytes", "1", "extra"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseRatesFlags(tc.args); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

// TestParseRatesFlagsReportsAllMissingRequiredFlags pins the same
// "reports missing required flags one at a time" fix notify.go's own test
// pins (TestParseNotifyFlagsReportsAllMissingRequiredFlags).
func TestParseRatesFlagsReportsAllMissingRequiredFlags(t *testing.T) {
	_, err := parseRatesFlags(nil)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	msg := err.Error()
	for _, want := range []string{"--provider-pubkey <64hex>", "--size-bytes <n>"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not mention missing flag %q", msg, want)
		}
	}
}

// TestCheckProviderRatesRejectsBadKeyLength is the one part of
// checkProviderRates we can exercise without a network — mirrors
// TestNotifyProviderRejectsBadKeyLength (notify_test.go).
func TestCheckProviderRatesRejectsBadKeyLength(t *testing.T) {
	_, err := checkProviderRates(nil, []byte{1, 2, 3}, 100, mainnetGlobalConfigURL, time.Second)
	if err == nil {
		t.Fatal("expected an error for a short provider key, got nil")
	}
}
