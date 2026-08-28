package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"math/big"
	"math/rand"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tlb"
	"github.com/xssnick/tonutils-go/tvm/cell"
)

// update-providers sends a bare modify_providers (op 0x3dc680ae) message to
// an ALREADY-DEPLOYED StorageV1 contract — no StateInit, no new contract
// address. This is the REPAIR path for the 2026-08-23 incident: `deploy`
// (before this fix) wrote the wrong 32 bytes into ActiveProviders (a real TON
// wallet address instead of the provider's ProviderKey pubkey), so the
// provider daemon can never find itself there. Verified empirically that this
// is repairable in place, not a lost-funds situation: contract.
// PrepareV1DeployData's `data` cell (which determines the contract address)
// is built ONLY from bagID/merkleHash/dataSize/pieceSize/ownerAddr — the
// `providers` argument is used SOLELY to build `body`, never touching
// address/state (see v1.go). Re-running `deploy` offline with the ORIGINAL
// bag parameters and the CORRECTED pubkey reproduced the exact same live
// contract address, confirming this.
//
// mytonprovider.org's `price` field carries a 200GB/30-day cost estimate;
// see main.go field notes for the exact conversion before passing
// --rate-nano-per-mb-day here.
//
// IMPORTANT (per Codex deep-check, 2026-08-23): the on-chain ActiveProviders
// dict is REPLACED wholesale by whatever this message's body contains — it
// is not a merge/append. If a contract already has OTHER correctly-configured
// providers you want to keep, they must ALL be included in a single
// update-providers call (this program only supports one provider per call
// today — re-run for each, understanding that only the LAST call's set
// survives on-chain).
// checkUpdateProvidersGasGuard is the pure, network-free half of the
// --gas-ton/--max-spend-ton check — pulled out of runUpdateProviders (which
// also does a network call to fetch account state) so it is directly
// unit-testable, mirroring how buildDeploy's own max-spend guard is pure and
// tested without touching the network.
func checkUpdateProvidersGasGuard(gasNano, maxSpendNano *big.Int) error {
	if gasNano.Cmp(maxSpendNano) > 0 {
		return guardf(
			"--gas-ton %s nanoTON exceeds --max-spend-ton guard %s nanoTON — refusing to build the repair",
			gasNano, maxSpendNano,
		)
	}
	return nil
}

func buildUpdateProvidersBody(providerPubkey []byte, rateNanoPerMB uint64, spanDays uint64) (*cell.Cell, error) {
	if len(providerPubkey) != 32 {
		return nil, fmt.Errorf("provider pubkey must be 32 bytes, got %d", len(providerPubkey))
	}
	const uint32Max = uint64(^uint32(0))
	if spanDays == 0 {
		return nil, fmt.Errorf("span-days must be positive, got 0")
	}
	if spanDays > uint32Max/86400 {
		return nil, fmt.Errorf("span-days %d exceeds the uint32 max_span range (max %d days)", spanDays, uint32Max/86400)
	}
	if rateNanoPerMB == 0 {
		return nil, fmt.Errorf("rate-nano-per-mb-day must be positive, got 0")
	}

	// Faithful copy of the dict/body construction inside
	// contract.PrepareV1DeployData (pkg/contract/v1.go) — reproduced here
	// rather than called through that function because PrepareV1DeployData
	// also requires bagID/merkleHash/dataSize/pieceSize/ownerAddr purely to
	// build a StateInit this repair path doesn't need (the contract already
	// has one on-chain; sending a second, different StateInit to an already-
	// active account would be ignored by the network, not harmful, but this
	// program has no direct-body-only entry point in the upstream package to
	// call instead — the raw fields (opcode 0x3dc680ae, dict layout) are
	// exactly what that function does internally).
	rate := tlb.FromNanoTONU(rateNanoPerMB)
	providersDict := cell.NewDict(256)
	err := providersDict.SetIntKey(new(big.Int).SetBytes(providerPubkey),
		cell.BeginCell().
			MustStoreUInt(uint64(spanDays*86400), 32).
			MustStoreBigCoins(rate.Nano()).
			EndCell())
	if err != nil {
		return nil, fmt.Errorf("build providers dict: %w", err)
	}

	body := cell.BeginCell().
		MustStoreUInt(0x3dc680ae, 32).
		MustStoreUInt(uint64(rand.Int63()), 64).
		MustStoreDict(providersDict).
		EndCell()
	return body, nil
}

// buildUpdateProvidersDeeplink mirrors buildDeployDeeplink (deeplink.go) but
// omits `init=` entirely — the contract already exists on-chain, so this is
// a plain internal message, not a deploy.
func buildUpdateProvidersDeeplink(contractAddr *address.Address, bodyBOC []byte, amountNano *big.Int, testnet bool) string {
	addr := contractAddr.Copy().Bounce(true).Testnet(testnet)
	return fmt.Sprintf(
		"ton://transfer/%s?bin=%s&amount=%s",
		addr.String(),
		base64.URLEncoding.EncodeToString(bodyBOC),
		amountNano.String(),
	)
}

type updateProvidersParams struct {
	contract       *address.Address
	providerPubkey []byte
	rateNanoPerMB  uint64
	spanDays       uint64
	gasNano        *big.Int
	maxSpendNano   *big.Int
	testnet        bool
}

type updateProvidersFlags struct {
	contractRaw       string
	providerPubkeyRaw string
	rateRaw           string
	spanDaysRaw       string
	gasTon            string
	maxSpendTon       string
	mainnet           bool
}

var defaultUpdateProvidersGasNano = big.NewInt(50_000_000) // 0.05 TON — message-processing gas only; the contract keeps its existing balance

func parseUpdateProvidersFlags(args []string) (*updateProvidersParams, error) {
	fs := newFlagSet("update-providers")
	f := &updateProvidersFlags{}
	fs.StringVar(&f.contractRaw, "contract", "", "the ALREADY-DEPLOYED StorageV1 contract's raw address (required)")
	fs.StringVar(&f.providerPubkeyRaw, "provider-pubkey", "", "provider's ProviderKey (Ed25519) public key, 64 hex chars — NOT ADNLKey or a wallet address (required)")
	fs.StringVar(&f.rateRaw, "rate-nano-per-mb-day", "", "nanoTON/MB/day (required)")
	fs.StringVar(&f.spanDaysRaw, "span-days", "", "proof span in days (required)")
	fs.StringVar(&f.gasTon, "gas-ton", "0.05", "TON to attach for message-processing gas only (the contract's existing balance is NOT re-sent)")
	fs.StringVar(&f.maxSpendTon, "max-spend-ton", "0.1", "refuse if --gas-ton would exceed this many TON")
	fs.BoolVar(&f.mainnet, "mainnet", false, "opt in to mainnet (REAL FUNDS)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}

	if err := checkRequiredFlags("update-providers",
		requiredFlag{"--contract <raw-addr>", f.contractRaw},
		requiredFlag{"--provider-pubkey <64hex>", f.providerPubkeyRaw},
		requiredFlag{"--rate-nano-per-mb-day <int>", f.rateRaw},
		requiredFlag{"--span-days <int>", f.spanDaysRaw},
	); err != nil {
		return nil, err
	}

	contractAddr, err := parseRawAddr("--contract", f.contractRaw, 0, -1)
	if err != nil {
		return nil, err
	}
	providerPubkey, err := parseHex32("--provider-pubkey", f.providerPubkeyRaw)
	if err != nil {
		return nil, err
	}
	rate, err := parsePositiveUint64Flag("--rate-nano-per-mb-day", f.rateRaw)
	if err != nil {
		return nil, err
	}
	spanDays, err := parsePositiveUint64Flag("--span-days", f.spanDaysRaw)
	if err != nil {
		return nil, err
	}

	gasCoins, err := tlb.FromTON(f.gasTon)
	if err != nil {
		return nil, fmt.Errorf("--gas-ton must be a positive decimal number, got %q: %w", f.gasTon, err)
	}
	gasNano := gasCoins.Nano()
	if gasNano.Sign() <= 0 {
		return nil, fmt.Errorf("--gas-ton must be positive, got %q", f.gasTon)
	}

	maxSpendCoins, err := tlb.FromTON(f.maxSpendTon)
	if err != nil {
		return nil, fmt.Errorf("--max-spend-ton must be a positive decimal number, got %q: %w", f.maxSpendTon, err)
	}
	maxSpendNano := maxSpendCoins.Nano()
	if maxSpendNano.Sign() <= 0 {
		return nil, fmt.Errorf("--max-spend-ton must be positive, got %q", f.maxSpendTon)
	}

	return &updateProvidersParams{
		contract:       contractAddr,
		providerPubkey: providerPubkey,
		rateNanoPerMB:  rate,
		spanDays:       spanDays,
		gasNano:        gasNano,
		maxSpendNano:   maxSpendNano,
		testnet:        !f.mainnet,
	}, nil
}

func runUpdateProviders(ctx context.Context, args []string, stdout io.Writer) error {
	p, err := parseUpdateProvidersFlags(args)
	if errIsHelp(err) {
		fmt.Fprint(stdout, subHelpText("update-providers"))
		return nil
	}
	if err != nil {
		return err
	}

	// Run the pure, network-free checks first — the --gas-ton/--max-spend-ton
	// guard and buildUpdateProvidersBody's own validation (--span-days
	// overflow, --rate-nano-per-mb-day) are static, input-only checks, so a
	// local mistake here fails fast instead of paying for a tonapi round
	// trip first (and getting a misleading "contract not active"-style error
	// for what is actually the caller's own typo).
	if err := checkUpdateProvidersGasGuard(p.gasNano, p.maxSpendNano); err != nil {
		return err
	}
	body, err := buildUpdateProvidersBody(p.providerPubkey, p.rateNanoPerMB, p.spanDays)
	if err != nil {
		return err
	}

	network := "mainnet"
	if p.testnet {
		network = "testnet"
	}
	fmt.Fprintf(stdout, "checking on-chain state of %s (%s) before repairing ...\n", p.contract.StringRaw(), network)
	acc, err := fetchAccountState(ctx, p.contract, p.testnet)
	if err != nil {
		return fmt.Errorf("could not fetch account state from tonapi — refusing to build a repair for a contract whose state is unknown: %w", err)
	}
	fmt.Fprintf(stdout, "  status: %s — %s\n", acc.Status, stateVerdict(acc.Status))
	if acc.Status == "nonexist" {
		return guardf("contract %s is nonexist on %s — update-providers is only for an ALREADY-DEPLOYED contract; use deploy instead", p.contract.StringRaw(), network)
	}
	// Codex review finding (Warning): unlike notify (a read-only-ish ADNL
	// query that's harmless to send early), a body-only modify_providers
	// message CANNOT initialize an uninitialized account or revive a frozen
	// one — sending it to anything other than 'active' cannot succeed and
	// just wastes --gas-ton. This is therefore a hard refusal, not a warning
	// to proceed past. If tonapi is genuinely lagging a just-landed deploy,
	// the fix is to wait and re-run `status` until it reports 'active', not
	// to fire a repair blind.
	if acc.Status != "active" {
		return guardf(
			"contract %s status is %q, not 'active' — a body-only modify_providers message cannot initialize or revive it; wait for `status` to report 'active' and retry",
			p.contract.StringRaw(), acc.Status,
		)
	}

	deeplink := buildUpdateProvidersDeeplink(p.contract, body.ToBOC(), p.gasNano, p.testnet)

	if !p.testnet {
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "!! MAINNET MODE — REAL TON, REAL MONEY. Review the deeplink in your wallet !!")
		fmt.Fprintln(stdout, "!! before approving. There is no undo.                                    !!")
		fmt.Fprintln(stdout, "")
	}

	fmt.Fprintln(stdout, "== update-providers (repair, no new contract) ==")
	fmt.Fprintf(stdout, "  network:         %s\n", network)
	fmt.Fprintf(stdout, "  contract addr:   %s (UNCHANGED — same account, existing balance untouched)\n", p.contract.StringRaw())
	fmt.Fprintf(stdout, "  provider pubkey: %x\n", p.providerPubkey)
	fmt.Fprintf(stdout, "  rate:            %d nanoTON/MB/day\n", p.rateNanoPerMB)
	fmt.Fprintf(stdout, "  span:            %d day(s)\n", p.spanDays)
	fmt.Fprintf(stdout, "  gas attached:    %.9f TON (%s nanoTON) — NOT a re-funding of storage cost\n", nanoToFloat(p.gasNano), p.gasNano)
	fmt.Fprintf(stdout, "  deeplink:        %s\n", deeplink)
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "This REPLACES the entire on-chain provider list with just the one entry above")
	fmt.Fprintln(stdout, "— any other providers already on this contract would be dropped. Review before signing.")
	fmt.Fprintln(stdout, "After signing, confirm with:")
	statusFlag := ""
	if !p.testnet {
		statusFlag = " --mainnet"
	}
	fmt.Fprintf(stdout, "  storage-v1-client notify --provider-pubkey %x --contract %s%s\n",
		p.providerPubkey, p.contract.StringRaw(), statusFlag)
	return nil
}
