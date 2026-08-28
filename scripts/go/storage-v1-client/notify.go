package main

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-storage-provider/pkg/transport"
)

const (
	mainnetGlobalConfigURL = "https://ton-blockchain.github.io/global.config.json"
	testnetGlobalConfigURL = "https://ton-blockchain.github.io/testnet-global.config.json"

	defaultNotifyTimeout = 20 * time.Second
)

func globalConfigURL(testnet bool) string {
	if testnet {
		return testnetGlobalConfigURL
	}
	return mainnetGlobalConfigURL
}

// notifyProvider pushes the ADNL/RLDP "storageProvider.storageRequest" query
// that is the only way (per main.go field notes) a provider daemon learns a
// contract exists for it. Ported call target:
// xssnick/tonutils-storage-provider pkg/transport/client.go
// Client.RequestStorageInfo, via the same ephemeral-key + ADNL-gateway +
// DHT-client setup shown in that repo's cmd/resolver/main.go and
// tonutils-go's example/resolve-adnl/main.go.
//
// UNVERIFIED IN THIS SESSION: not exercised against a live provider — see
// the completion report.
//
// Connection setup (ephemeral ADNL key + gateway + DHT client) is shared
// with rates.go's checkProviderRates via newProviderTransportClient
// (providerclient.go) — factored out 2026-08-29 (issue #651) when a second
// subcommand needed the identical setup; behavior here is unchanged.
func notifyProvider(ctx context.Context, providerKey []byte, contractAddr *address.Address, byteToProof uint64, configURL string, timeout time.Duration) (*transport.StorageResponse, error) {
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
	resp, err := tc.RequestStorageInfo(qctx, providerKey, contractAddr, byteToProof)
	if err != nil {
		return nil, fmt.Errorf("storageProvider.storageRequest to provider %x: %w", providerKey, err)
	}
	return resp, nil
}

// notifyParams / parseNotifyFlags is the pure (network-free) argument
// parsing half of `notify`, unit-testable without touching the network.
//
// providerPubkey is deliberately a raw 32-byte key, NOT an *address.Address:
// verified against xssnick/tonutils-storage-provider@v0.4.3 pkg/transport/
// client.go connect() — RequestStorageInfo's `provider []byte` parameter is
// wrapped as keys.PublicKeyED25519{Key: providerKey} and hashed to build the
// DHT lookup key. This is the provider's ProviderKey (Ed25519) public key —
// NOT its lower-level ADNLKey (the stock daemon generates those as separate
// keys) — which
// mytonprovider.org's registry exposes as its own `pubkey` field — a
// DIFFERENT 32 bytes from the provider's TON wallet `address` field (used by
// `deploy`'s --provider instead; see main.go field notes and deploy.go).
// Confirmed empirically (2026-08-23): decoding two real registry entries'
// friendly `address` down to its 32-byte hash never matched that same
// entry's `pubkey`. An earlier version of this program conflated the two
// under one --provider flag and derived the notify key via
// (*address.Address).Data() on it, which is silently wrong for both possible
// choices of what to pass there — see the fix commit for detail.
type notifyParams struct {
	providerPubkey []byte
	contract       *address.Address
	byteToProof    uint64
	timeout        time.Duration
	testnet        bool
}

func parseNotifyFlags(args []string) (*notifyParams, error) {
	fs := newFlagSet("notify")
	providerPubkeyRaw := fs.String("provider-pubkey", "", "provider's ProviderKey (Ed25519) public key, 64 hex chars — mytonprovider.org's registry 'pubkey' field; NOT ADNLKey or a wallet address (required)")
	contractRaw := fs.String("contract", "", "deployed StorageV1 contract address (required)")
	byteToProofRaw := fs.Uint64("byte-to-proof", 0, "byte offset to ask the provider to prove")
	timeoutSeconds := fs.Uint64("timeout", uint64(defaultNotifyTimeout/time.Second), "ADNL/DHT operation timeout, in seconds")
	mainnet := fs.Bool("mainnet", false, "opt in to mainnet")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}
	if err := checkRequiredFlags("notify",
		requiredFlag{"--provider-pubkey <64hex>", *providerPubkeyRaw},
		requiredFlag{"--contract <raw-addr>", *contractRaw},
	); err != nil {
		return nil, err
	}
	providerPubkey, err := parseHex32("--provider-pubkey", *providerPubkeyRaw)
	if err != nil {
		return nil, err
	}
	contractAddr, err := parseRawAddr("--contract", *contractRaw, 0, -1)
	if err != nil {
		return nil, err
	}
	if *timeoutSeconds == 0 || *timeoutSeconds > 600 {
		return nil, fmt.Errorf("--timeout must be in [1, 600] seconds, got %d", *timeoutSeconds)
	}

	return &notifyParams{
		providerPubkey: providerPubkey,
		contract:       contractAddr,
		byteToProof:    *byteToProofRaw,
		timeout:        time.Duration(*timeoutSeconds) * time.Second,
		testnet:        !*mainnet,
	}, nil
}

// runNotify checks --contract's on-chain account state first (via the same
// read-only tonapi call `status` uses) and refuses if it is 'nonexist' — see
// main.go --help "notify" for why. Anything else is a warning, not a refusal
// (tonapi indexing can lag a just-signed deploy).
func runNotify(ctx context.Context, args []string, stdout io.Writer) error {
	p, err := parseNotifyFlags(args)
	if errIsHelp(err) {
		fmt.Fprint(stdout, subHelpText("notify"))
		return nil
	}
	if err != nil {
		return err
	}

	network := "mainnet"
	if p.testnet {
		network = "testnet"
	}
	fmt.Fprintf(stdout, "checking on-chain state of %s (%s) before notifying the provider ...\n", p.contract.StringRaw(), network)
	acc, err := fetchAccountState(ctx, p.contract, p.testnet)
	if err != nil {
		return fmt.Errorf("could not fetch account state from tonapi — refusing to notify blind: %w", err)
	}
	fmt.Fprintf(stdout, "  status: %s — %s\n", acc.Status, stateVerdict(acc.Status))
	if acc.Status == "nonexist" {
		return guardf("contract %s is nonexist on %s (nothing deployed there yet) — refusing to notify", p.contract.StringRaw(), network)
	}
	if acc.Status != "active" {
		fmt.Fprintf(stdout, "  [WARN] account status is %q, not 'active' — the provider daemon requires an active,\n", acc.Status)
		fmt.Fprintln(stdout, "  correctly-coded contract (internal/service.FetchStorageInfo checks both) to respond usefully;")
		fmt.Fprintln(stdout, "  proceeding anyway in case tonapi's index is just lagging the signed transaction.")
	}

	fmt.Fprintf(stdout, "sending storageProvider.storageRequest to provider %x (byte_to_proof=%d, timeout=%s) ...\n",
		p.providerPubkey, p.byteToProof, p.timeout)

	resp, err := notifyProvider(ctx, p.providerPubkey, p.contract, p.byteToProof, globalConfigURL(p.testnet), p.timeout)
	if err != nil {
		return err
	}

	fmt.Fprintln(stdout, "== notify response ==")
	fmt.Fprintf(stdout, "  status:     %s\n", resp.Status)
	fmt.Fprintf(stdout, "  reason:     %s\n", resp.Reason)
	fmt.Fprintf(stdout, "  downloaded: %d bytes\n", resp.Downloaded)
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "This is the provider's own self-report, not independently verified against a")
	fmt.Fprintln(stdout, "merkle proof (unlike xssnick/tonutils-storage's provider.Client, this program")
	fmt.Fprintln(stdout, "does not call VerifyStorageADNLProof / checkProofBranch) — treat 'active' here as a")
	fmt.Fprintln(stdout, "claim to re-check later (e.g. via mytonstorage.org or your own status polling),")
	fmt.Fprintln(stdout, "not as proof of custody.")
	return nil
}
