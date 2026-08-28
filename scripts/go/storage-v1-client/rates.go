package main

import (
	"context"
	"fmt"
	"io"
	"math/big"
	"time"

	"github.com/xssnick/tonutils-storage-provider/pkg/transport"
)

// checkProviderRates queries the ADNL/RLDP "storageProvider.ratesRequest" —
// a provider's LIVE terms (available/rate/min_bounty/space/span) for the
// given bag size, as opposed to mytonprovider.org's registry snapshot
// (issue #651): the registry can go stale between when a client last
// searched it and when a deploy is actually broadcast, and that mismatch
// was previously only ever discovered by 'notify' — AFTER the contract had
// already been funded. Ported call target, same as notifyProvider (notify.go):
// xssnick/tonutils-storage-provider pkg/transport/client.go
// Client.GetStorageRates.
//
// UNVERIFIED IN THIS SESSION: not exercised against a live provider — same
// caveat as notifyProvider (notify.go); everything through 'go build'/
// 'go test' (DHT client construction, ADNL gateway startup, argument
// validation) is exercised, the actual network round trip is not.
func checkProviderRates(ctx context.Context, providerKey []byte, sizeBytes uint64, configURL string, timeout time.Duration) (*transport.StorageRatesResponse, error) {
	if len(providerKey) != 32 {
		return nil, fmt.Errorf("provider key must be 32 bytes, got %d", len(providerKey))
	}

	tc, closeClient, err := newProviderTransportClient(ctx, configURL, timeout)
	if err != nil {
		return nil, err
	}
	defer closeClient()

	qctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := tc.GetStorageRates(qctx, providerKey, sizeBytes)
	if err != nil {
		return nil, fmt.Errorf("storageProvider.ratesRequest to provider %x: %w", providerKey, err)
	}
	return resp, nil
}

// ratesParams / parseRatesFlags is the pure (network-free) argument parsing
// half of `rates`, unit-testable without touching the network — same shape
// as notify.go's notifyParams/parseNotifyFlags.
type ratesParams struct {
	providerPubkey []byte
	sizeBytes      uint64
	timeout        time.Duration
	testnet        bool
}

func parseRatesFlags(args []string) (*ratesParams, error) {
	fs := newFlagSet("rates")
	providerPubkeyRaw := fs.String("provider-pubkey", "", "provider's ProviderKey (Ed25519) public key, 64 hex chars — mytonprovider.org's registry 'pubkey' field; same value 'deploy'/'notify' take (required)")
	sizeBytesRaw := fs.String("size-bytes", "", "bag size in bytes — the provider's own GetStorageInfo() call is keyed by this, so its 'available' verdict reflects capacity for THIS bag (required)")
	timeoutSeconds := fs.Uint64("timeout", uint64(defaultNotifyTimeout/time.Second), "ADNL/DHT operation timeout, in seconds")
	mainnet := fs.Bool("mainnet", false, "opt in to mainnet")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}
	if err := checkRequiredFlags("rates",
		requiredFlag{"--provider-pubkey <64hex>", *providerPubkeyRaw},
		requiredFlag{"--size-bytes <n>", *sizeBytesRaw},
	); err != nil {
		return nil, err
	}
	providerPubkey, err := parseHex32("--provider-pubkey", *providerPubkeyRaw)
	if err != nil {
		return nil, err
	}
	sizeBytes, err := parsePositiveUint64Flag("--size-bytes", *sizeBytesRaw)
	if err != nil {
		return nil, err
	}
	if *timeoutSeconds == 0 || *timeoutSeconds > 600 {
		return nil, fmt.Errorf("--timeout must be in [1, 600] seconds, got %d", *timeoutSeconds)
	}

	return &ratesParams{
		providerPubkey: providerPubkey,
		sizeBytes:      sizeBytes,
		timeout:        time.Duration(*timeoutSeconds) * time.Second,
		testnet:        !*mainnet,
	}, nil
}

// runRates prints a parseable "== rates response ==" block, mirroring
// notify.go's runNotify output shape so callers that already parse one
// (src/lib/backends/ton-provider.ts) can parse the other the same way.
//
// RatePerMBDay/MinBounty arrive as big-endian minimal-length byte strings
// (the upstream provider server populates them via tlb.Coins.Nano().Bytes()
// — internal/server/adnl.go, xssnick/tonutils-storage-provider@v0.4.3), the
// same nanoTON encoding this program's own deploy.go/amount.go already work
// with as big.Int — decoded here with big.Int.SetBytes rather than any
// fixed-width uint conversion, since the byte length varies with the value.
//
// space_available is printed AS RETURNED, unconverted: despite the TL
// schema's field name (`space_available_mb`) and struct field
// (SpaceAvailableMB), the reference provider server actually populates it
// with a raw BYTE count (internal/service/service.go GetStorageInfo:
// spaceAvailable is derived from spaceAllocated/maxBagSize, both configured
// and compared in bytes elsewhere in that same file) — treating it as
// megabytes here would silently misreport by a factor of ~10^6. Callers
// needing a pass/fail capacity verdict for a specific size should rely on
// `available` instead (already computed against the size this query asked
// for), not attempt to re-derive it from this field's ambiguous unit.
func runRates(ctx context.Context, args []string, stdout io.Writer) error {
	p, err := parseRatesFlags(args)
	if errIsHelp(err) {
		fmt.Fprint(stdout, subHelpText("rates"))
		return nil
	}
	if err != nil {
		return err
	}

	network := "mainnet"
	if p.testnet {
		network = "testnet"
	}
	fmt.Fprintf(stdout, "sending storageProvider.ratesRequest to provider %x for %d bytes (%s, timeout=%s) ...\n",
		p.providerPubkey, p.sizeBytes, network, p.timeout)

	resp, err := checkProviderRates(ctx, p.providerPubkey, p.sizeBytes, globalConfigURL(p.testnet), p.timeout)
	if err != nil {
		return err
	}

	fmt.Fprintln(stdout, "== rates response ==")
	fmt.Fprintf(stdout, "  available:            %t\n", resp.Available)
	fmt.Fprintf(stdout, "  rate_nano_per_mb_day: %s\n", new(big.Int).SetBytes(resp.RatePerMBDay).String())
	fmt.Fprintf(stdout, "  min_bounty_nano:      %s\n", new(big.Int).SetBytes(resp.MinBounty).String())
	fmt.Fprintf(stdout, "  space_available:      %d\n", resp.SpaceAvailableMB)
	fmt.Fprintf(stdout, "  min_span:             %d\n", resp.MinSpan)
	fmt.Fprintf(stdout, "  max_span:             %d\n", resp.MaxSpan)
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "This is the provider's LIVE ADNL terms — compare it against the terms a deploy is")
	fmt.Fprintln(stdout, "about to be built with (from mytonprovider.org's registry snapshot, which can be")
	fmt.Fprintln(stdout, "stale) BEFORE broadcasting/signing, not only via 'notify' after payment.")
	return nil
}
