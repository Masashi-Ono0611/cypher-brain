package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tlb"
	"github.com/xssnick/tonutils-go/tvm/cell"
	"github.com/xssnick/tonutils-storage-provider/pkg/contract"
)

// buildLiveStorageV1Data assembles an account data cell in the shape a LIVE
// StorageV1 contract holds — i.e. with the ActiveProviders dict populated,
// which PrepareV1DeployData's own StateInit data cell never is (the providers
// travel in the separate modify_providers body and the contract merges them in
// when it first runs; see main.go's field notes).
//
// The per-provider dict VALUE mirrors what a real mainnet StorageV1 account
// was measured to hold (2026-09-02, contract
// 0:465347a9b5152bf6f69e1bc47ce82c537aee5ae4e3d00437d4a514f0e9cc452a): 160
// inline bits of the contract's own proof bookkeeping, plus ONE ref carrying
// the {max_span:uint32, rate:Coins} pair. Reproducing that exact shape here is
// the point of this helper — a fixture built from the DEPLOY body's simpler
// {max_span, rate}-inline layout would pass while the decoder failed against
// anything real.
func buildLiveStorageV1Data(t *testing.T, entries map[string][2]uint64) *cell.Cell {
	t.Helper()
	dict := cell.NewDict(256)
	for pubkeyHex, spanAndRate := range entries {
		pubkey, err := hex.DecodeString(pubkeyHex)
		if err != nil {
			t.Fatalf("bad fixture pubkey %q: %v", pubkeyHex, err)
		}
		terms := cell.BeginCell().
			MustStoreUInt(spanAndRate[0], 32).
			MustStoreBigCoins(new(big.Int).SetUint64(spanAndRate[1])).
			EndCell()
		value := cell.BeginCell().
			MustStoreUInt(0x013b7dac, 64). // byte-to-prove-ish bookkeeping: NOT decoded by design
			MustStoreUInt(0x6a8a8352, 32). // last-proof-time-ish
			MustStoreUInt(0x60d0f9ae, 64). // proof nonce-ish
			MustStoreRef(terms).
			EndCell()
		if err := dict.SetIntKey(new(big.Int).SetBytes(pubkey), value); err != nil {
			t.Fatalf("SetIntKey: %v", err)
		}
	}
	owner, err := parseRawAddr("--owner", "0:"+strings.Repeat("b", 64), 0, -1)
	if err != nil {
		t.Fatalf("parseRawAddr: %v", err)
	}
	data, err := tlb.ToCell(contract.StorageV1{
		TorrentHash:     bytes.Repeat([]byte{0x11}, 32),
		ActiveProviders: dict,
		OwnerAddr:       owner,
		DataSize:        481490005,
		PieceSize:       131072,
		MerkleHash:      bytes.Repeat([]byte{0x22}, 32),
		KeyLen:          12,
	})
	if err != nil {
		t.Fatalf("tlb.ToCell: %v", err)
	}
	return data
}

func TestParseProvidersFlags(t *testing.T) {
	p, err := parseProvidersFlags([]string{"--address", "0:" + strings.Repeat("c", 64)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.testnet {
		t.Fatal("expected testnet=true by default")
	}
	p, err = parseProvidersFlags([]string{"--address", "0:" + strings.Repeat("c", 64), "--mainnet"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.testnet {
		t.Fatal("expected testnet=false with --mainnet")
	}
}

func TestParseProvidersFlagsErrors(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"missing address", nil},
		{"empty address", []string{"--address", ""}},
		{"malformed address", []string{"--address", "not-an-address"}},
		{"extra args", []string{"--address", "0:" + strings.Repeat("c", 64), "extra"}},
		{"contract instead of address", []string{"--contract", "0:" + strings.Repeat("c", 64)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseProvidersFlags(tc.args); err == nil {
				t.Fatalf("expected an error for %s, got nil", tc.name)
			}
		})
	}
}

// TestDecodeActiveProvidersReadsKeyAndTerms is the core decode check: the dict
// KEY must come back as the provider's 64-hex pubkey (the authoritative answer
// this subcommand exists for), and the terms must come out of the value's ref.
func TestDecodeActiveProvidersReadsKeyAndTerms(t *testing.T) {
	pubkey := strings.Repeat("ab", 32)
	data := buildLiveStorageV1Data(t, map[string][2]uint64{pubkey: {16588800, 800}})
	got, err := decodeActiveProviders(hex.EncodeToString(data.ToBOC()))
	if err != nil {
		t.Fatalf("decodeActiveProviders: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d providers, want 1: %+v", len(got), got)
	}
	if got[0].Pubkey != pubkey {
		t.Fatalf("pubkey = %q, want %q", got[0].Pubkey, pubkey)
	}
	if got[0].Terms == nil {
		t.Fatal("terms = nil, want the {max_span, rate} pair from the value's ref")
	}
	if got[0].Terms.MaxSpanSeconds != 16588800 {
		t.Errorf("max_span_seconds = %d, want 16588800", got[0].Terms.MaxSpanSeconds)
	}
	if got[0].Terms.RateNanoPerMBDay != "800" {
		t.Errorf("rate_nano_per_mb_day = %q, want \"800\"", got[0].Terms.RateNanoPerMBDay)
	}
}

// A pubkey with leading zero bytes must still come back as 64 hex characters —
// the dict key is a 256-bit integer, so a naive big.Int-to-hex would drop them
// and produce a value no --provider-pubkey flag would accept.
func TestDecodeActiveProvidersLeftPadsShortKeys(t *testing.T) {
	pubkey := "0000" + strings.Repeat("cd", 30)
	data := buildLiveStorageV1Data(t, map[string][2]uint64{pubkey: {86400, 50}})
	got, err := decodeActiveProviders(hex.EncodeToString(data.ToBOC()))
	if err != nil {
		t.Fatalf("decodeActiveProviders: %v", err)
	}
	if len(got) != 1 || got[0].Pubkey != pubkey {
		t.Fatalf("got %+v, want the leading zeros preserved in %q", got, pubkey)
	}
}

func TestDecodeActiveProvidersMultipleEntries(t *testing.T) {
	a, b := strings.Repeat("ab", 32), strings.Repeat("cd", 32)
	data := buildLiveStorageV1Data(t, map[string][2]uint64{a: {86400, 100}, b: {172800, 200}})
	got, err := decodeActiveProviders(hex.EncodeToString(data.ToBOC()))
	if err != nil {
		t.Fatalf("decodeActiveProviders: %v", err)
	}
	seen := map[string]bool{}
	for _, p := range got {
		seen[p.Pubkey] = true
	}
	if len(got) != 2 || !seen[a] || !seen[b] {
		t.Fatalf("got %+v, want both %s and %s", got, a, b)
	}
}

// An EMPTY dict is a real answer ("this active contract names nobody"), not a
// decode failure — a caller must be able to act on it.
func TestDecodeActiveProvidersEmptyDictIsNotAnError(t *testing.T) {
	data := buildLiveStorageV1Data(t, nil)
	got, err := decodeActiveProviders(hex.EncodeToString(data.ToBOC()))
	if err != nil {
		t.Fatalf("decodeActiveProviders: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %+v, want an empty list", got)
	}
}

// Losing the terms must not lose the identity: a value whose ref is missing
// (an unexpected/newer layout) still reports its pubkey, with terms null.
func TestDecodeActiveProvidersKeepsPubkeyWhenTermsAreUnreadable(t *testing.T) {
	pubkey := strings.Repeat("ef", 32)
	pk, err := hex.DecodeString(pubkey)
	if err != nil {
		t.Fatalf("hex: %v", err)
	}
	dict := cell.NewDict(256)
	// No ref at all — the shape decodeProviderTerms must decline rather than
	// error the whole read on.
	if err := dict.SetIntKey(new(big.Int).SetBytes(pk), cell.BeginCell().MustStoreUInt(1, 8).EndCell()); err != nil {
		t.Fatalf("SetIntKey: %v", err)
	}
	owner, err := parseRawAddr("--owner", "0:"+strings.Repeat("b", 64), 0, -1)
	if err != nil {
		t.Fatalf("parseRawAddr: %v", err)
	}
	data, err := tlb.ToCell(contract.StorageV1{
		TorrentHash:     bytes.Repeat([]byte{0x11}, 32),
		ActiveProviders: dict,
		OwnerAddr:       owner,
		DataSize:        1,
		PieceSize:       1,
		MerkleHash:      bytes.Repeat([]byte{0x22}, 32),
	})
	if err != nil {
		t.Fatalf("tlb.ToCell: %v", err)
	}
	got, err := decodeActiveProviders(hex.EncodeToString(data.ToBOC()))
	if err != nil {
		t.Fatalf("decodeActiveProviders: %v", err)
	}
	if len(got) != 1 || got[0].Pubkey != pubkey {
		t.Fatalf("got %+v, want the pubkey %s to survive", got, pubkey)
	}
	if got[0].Terms != nil {
		t.Fatalf("terms = %+v, want nil for an unreadable value shape", got[0].Terms)
	}
}

func TestDecodeActiveProvidersRejectsGarbage(t *testing.T) {
	cases := map[string]string{
		"empty":       "",
		"not hex":     "zzzz",
		"not a BOC":   "deadbeef",
		"not storage": hex.EncodeToString(cell.BeginCell().MustStoreUInt(7, 8).EndCell().ToBOC()),
	}
	for name, dataHex := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeActiveProviders(dataHex); err == nil {
				t.Fatalf("expected an error for %s, got nil", name)
			}
		})
	}
}

// runProviders end-to-end against a stub tonapi: the JSON on stdout is the
// contract this subcommand's only in-repo caller (ton-provider.ts) parses.
func TestRunProvidersPrintsJSON(t *testing.T) {
	pubkey := strings.Repeat("ab", 32)
	data := buildLiveStorageV1Data(t, map[string][2]uint64{pubkey: {16588800, 800}})
	withMockTonapiPaths(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":  "active",
			"balance": 5000000000,
			"data":    hex.EncodeToString(data.ToBOC()),
		})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out bytes.Buffer
	addr := "0:" + strings.Repeat("c", 64)
	if err := runProviders(ctx, []string{"--address", addr}, &out); err != nil {
		t.Fatalf("runProviders: %v", err)
	}
	var got providersOutput
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("stdout is not JSON (%v): %s", err, out.String())
	}
	if got.Address != address.MustParseRawAddr(addr).StringRaw() {
		t.Errorf("address = %q, want %q", got.Address, addr)
	}
	if got.Network != "testnet" || got.Status != "active" {
		t.Errorf("network/status = %q/%q, want testnet/active", got.Network, got.Status)
	}
	if len(got.Providers) != 1 || got.Providers[0].Pubkey != pubkey {
		t.Fatalf("providers = %+v, want exactly %s", got.Providers, pubkey)
	}
}

// A non-'active' account is a REFUSAL (guardError -> exit 2), never an empty
// list: "has not run yet" must not be indistinguishable from "names nobody".
func TestRunProvidersRefusesNonActiveWithGuardError(t *testing.T) {
	for _, st := range []string{"nonexist", "uninit", "frozen"} {
		t.Run(st, func(t *testing.T) {
			withMockTonapiPaths(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"status": st, "balance": 0})
			})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var out bytes.Buffer
			err := runProviders(ctx, []string{"--address", "0:" + strings.Repeat("c", 64)}, &out)
			if err == nil {
				t.Fatalf("expected a refusal for status %q, got nil (stdout: %s)", st, out.String())
			}
			if _, ok := err.(*guardError); !ok {
				t.Fatalf("error %v is not a guardError, so run() would exit 1 instead of 2", err)
			}
		})
	}
}

// A tonapi failure must surface as an ordinary error (exit 1), so the caller
// falls back to its own records instead of reading an empty list as authority.
func TestRunProvidersFailsOnTonapiError(t *testing.T) {
	withMockTonapiPaths(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out bytes.Buffer
	err := runProviders(ctx, []string{"--address", "0:" + strings.Repeat("c", 64)}, &out)
	if err == nil {
		t.Fatal("expected an error when tonapi fails, got nil")
	}
	if _, ok := err.(*guardError); ok {
		t.Fatal("a tonapi failure must NOT be a guardError — exit 2 means a deliberate refusal, not 'could not read'")
	}
}

func TestRunProvidersHelp(t *testing.T) {
	var out bytes.Buffer
	if err := runProviders(context.Background(), []string{"--help"}, &out); err != nil {
		t.Fatalf("runProviders --help: %v", err)
	}
	if !strings.Contains(out.String(), "providers:") || !strings.Contains(out.String(), "--address") {
		t.Fatalf("--help output does not document the subcommand: %s", out.String())
	}
}
