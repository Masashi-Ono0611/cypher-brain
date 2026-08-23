package main

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"io"
	"time"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/adnl"
	"github.com/xssnick/tonutils-go/adnl/dht"
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
func notifyProvider(ctx context.Context, providerKey []byte, contractAddr *address.Address, byteToProof uint64, configURL string, timeout time.Duration) (*transport.StorageResponse, error) {
	if len(providerKey) != 32 {
		return nil, fmt.Errorf("provider key must be 32 bytes, got %d", len(providerKey))
	}

	_, prv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, fmt.Errorf("generate ephemeral ADNL key: %w", err)
	}

	gw := adnl.NewGateway(prv)
	if err := gw.StartClient(); err != nil {
		return nil, fmt.Errorf("start ADNL client gateway: %w", err)
	}
	defer gw.Close()

	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	dhtClient, err := dht.NewClientFromConfigUrl(dctx, gw, configURL)
	if err != nil {
		return nil, fmt.Errorf("create DHT client from %s: %w", configURL, err)
	}

	tc := transport.NewClient(gw, dhtClient)

	qctx, cancel2 := context.WithTimeout(ctx, timeout)
	defer cancel2()
	resp, err := tc.RequestStorageInfo(qctx, providerKey, contractAddr, byteToProof)
	if err != nil {
		return nil, fmt.Errorf("storageProvider.storageRequest to provider %x: %w", providerKey, err)
	}
	return resp, nil
}

// notifyParams / parseNotifyFlags is the pure (network-free) argument
// parsing half of `notify`, unit-testable without touching the network.
type notifyParams struct {
	provider    *address.Address
	contract    *address.Address
	byteToProof uint64
	timeout     time.Duration
	testnet     bool
}

func parseNotifyFlags(args []string) (*notifyParams, error) {
	fs := newFlagSet("notify")
	providerRaw := fs.String("provider", "", "raw workchain-0 provider address (required)")
	contractRaw := fs.String("contract", "", "deployed StorageV1 contract address (required)")
	byteToProofRaw := fs.Uint64("byte-to-proof", 0, "byte offset to ask the provider to prove")
	timeoutSeconds := fs.Uint64("timeout", 20, "ADNL/DHT operation timeout, in seconds")
	mainnet := fs.Bool("mainnet", false, "opt in to mainnet")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}
	if *providerRaw == "" {
		return nil, fmt.Errorf("notify requires --provider <raw-addr>")
	}
	provider, err := parseRawAddr("--provider", *providerRaw, 0)
	if err != nil {
		return nil, err
	}
	if *contractRaw == "" {
		return nil, fmt.Errorf("notify requires --contract <raw-addr>")
	}
	contractAddr, err := parseRawAddr("--contract", *contractRaw, 0, -1)
	if err != nil {
		return nil, err
	}
	if *timeoutSeconds == 0 || *timeoutSeconds > 600 {
		return nil, fmt.Errorf("--timeout must be in [1, 600] seconds, got %d", *timeoutSeconds)
	}

	return &notifyParams{
		provider:    provider,
		contract:    contractAddr,
		byteToProof: *byteToProofRaw,
		timeout:     time.Duration(*timeoutSeconds) * time.Second,
		testnet:     !*mainnet,
	}, nil
}

// runNotify checks --contract's on-chain account state first (via the same
// read-only tonapi call `status` uses) and refuses if it is 'nonexist' — see
// main.go --help "notify" for why. Anything else is a warning, not a refusal
// (tonapi indexing can lag a just-signed deploy).
func runNotify(ctx context.Context, args []string, stdout io.Writer) error {
	p, err := parseNotifyFlags(args)
	if errIsHelp(err) {
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

	fmt.Fprintf(stdout, "sending storageProvider.storageRequest to provider %s (byte_to_proof=%d, timeout=%s) ...\n",
		p.provider.StringRaw(), p.byteToProof, p.timeout)

	resp, err := notifyProvider(ctx, p.provider.Data(), p.contract, p.byteToProof, globalConfigURL(p.testnet), p.timeout)
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
