package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

// withMockTonapiPaths is like deploy_test.go's withMockTonapi, but lets the
// caller answer differently per request path — needed to reproduce #716's
// real-world shape, where the primary blockchain/accounts endpoint and the
// fallback plain accounts endpoint answer the SAME address differently.
func withMockTonapiPaths(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	prev := tonapiBaseOverride
	tonapiBaseOverride = srv.URL
	t.Cleanup(func() { tonapiBaseOverride = prev })
}

// TestFetchAccountStateFallsBackToPlainEndpointOn404 pins #716: a genuinely
// fresh address makes tonapi's blockchain/accounts endpoint answer HTTP 404
// (confirmed against the real API — see the issue), while the plain
// accounts endpoint answers the SAME address with an ordinary 200
// {"status":"nonexist"}. fetchAccountState must recover via the fallback
// rather than surfacing the 404 as a hard "could not fetch account state"
// error (status.go's runStatus/deploy.go's runDeploy would otherwise both
// refuse to proceed for the completely normal case of a brand-new bag/owner
// pair's very first deploy).
func TestFetchAccountStateFallsBackToPlainEndpointOn404(t *testing.T) {
	var sawBlockchainPath, sawPlainPath bool
	withMockTonapiPaths(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/blockchain/accounts/") {
			sawBlockchainPath = true
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"entity not found"}`))
			return
		}
		sawPlainPath = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "nonexist", "balance": 0})
	})

	addr, err := parseRawAddr("--contract", "0:"+strings.Repeat("a", 64), 0, -1)
	if err != nil {
		t.Fatalf("parseRawAddr: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	acc, err := fetchAccountState(ctx, addr, true)
	if err != nil {
		t.Fatalf("fetchAccountState: expected the 404 to be recovered via fallback, got error: %v", err)
	}
	if acc.Status != "nonexist" {
		t.Fatalf("acc.Status = %q, want %q", acc.Status, "nonexist")
	}
	if !sawBlockchainPath {
		t.Error("expected the primary blockchain/accounts endpoint to be queried first")
	}
	if !sawPlainPath {
		t.Error("expected the plain accounts endpoint to be queried as the 404 fallback")
	}
}

// TestFetchAccountStateSurfacesErrorWhenBothEndpointsFail is the negative
// control alongside the test above: a 404 on the primary endpoint must only
// be treated as "possibly nonexist, check the fallback" — if the fallback
// ALSO fails (e.g. a genuinely malformed address, or an outage affecting
// both tonapi endpoints), fetchAccountState must still return an error, not
// silently report the address as nonexist.
func TestFetchAccountStateSurfacesErrorWhenBothEndpointsFail(t *testing.T) {
	withMockTonapiPaths(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"entity not found"}`))
	})

	addr, err := parseRawAddr("--contract", "0:"+strings.Repeat("a", 64), 0, -1)
	if err != nil {
		t.Fatalf("parseRawAddr: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if _, err := fetchAccountState(ctx, addr, true); err == nil {
		t.Fatal("expected an error when both the primary and fallback endpoints 404, got nil")
	}
}

// TestFetchAccountStateDoesNotFallBackOnNon404Failure is a second negative
// control: a non-404 failure (timeout, 5xx, malformed body) from the primary
// endpoint must be returned as-is, never retried against the fallback URL —
// only a confirmed 404 is treated as potentially "not yet known to the
// blockchain-indexed view".
func TestFetchAccountStateDoesNotFallBackOnNon404Failure(t *testing.T) {
	var fallbackQueried bool
	withMockTonapiPaths(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/blockchain/accounts/") {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fallbackQueried = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "nonexist", "balance": 0})
	})

	addr, err := parseRawAddr("--contract", "0:"+strings.Repeat("a", 64), 0, -1)
	if err != nil {
		t.Fatalf("parseRawAddr: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if _, err := fetchAccountState(ctx, addr, true); err == nil {
		t.Fatal("expected a 500 from the primary endpoint to surface as an error, got nil")
	}
	if fallbackQueried {
		t.Error("a non-404 failure must not trigger the plain-endpoint fallback")
	}
}
