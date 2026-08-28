package main

import (
	"context"
	"fmt"
	"io"
	"math/big"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tlb"
	"github.com/xssnick/tonutils-storage-provider/pkg/contract"
)

// deployParams are the fully-resolved, already-validated inputs buildDeploy
// needs. Everything network-derived (bag size/piece size/merkle hash from
// the seeder) has already happened by the time this is constructed — see
// runDeploy — so buildDeploy itself is pure and unit-testable.
type deployParams struct {
	bagID          []byte // 32 bytes — StorageV1.TorrentHash
	merkleHash     []byte // 32 bytes — StorageV1.MerkleHash
	dataSizeBytes  uint64
	pieceSize      uint32
	owner          *address.Address
	providerPubkey []byte // 32 bytes — the provider's ProviderKey (Ed25519) public key, NOT a TON wallet address. Confirmed 2026-08-23 against xssnick source + a live incident: ActiveProviders is keyed by this exact value, and the contract's proof_storage handler runs check_signature against it — a wallet address (a StateInit hash) cannot satisfy that check. See main.go field notes for the full trail and the real-money incident that surfaced this.
	rateNanoPerMB  uint64
	spanDays       uint64
	maxSpendNano   *big.Int
	testnet        bool
}

type deployResult struct {
	contractAddr *address.Address
	stateInitBOC []byte
	bodyBOC      []byte
	costNano     *big.Int
	amountNano   *big.Int
	deeplink     string
}

// buildDeploy is the pure, network-free core of `deploy`. It calls
// contract.PrepareV1DeployData directly — the exact upstream function (see
// main.go header) — with a single ProviderV1 entry for --provider, so the
// deploy message both creates the contract AND adds that provider in one
// signed transaction (see main.go field notes on why ActiveProviders starts
// empty on-chain but the deploy body itself is not empty).
func buildDeploy(p deployParams) (*deployResult, error) {
	if len(p.bagID) != 32 {
		return nil, fmt.Errorf("bag id must be 32 bytes, got %d", len(p.bagID))
	}
	if len(p.merkleHash) != 32 {
		return nil, fmt.Errorf("merkle hash must be 32 bytes, got %d", len(p.merkleHash))
	}
	if len(p.providerPubkey) != 32 {
		return nil, fmt.Errorf("provider pubkey must be 32 bytes, got %d", len(p.providerPubkey))
	}

	const uint32Max = uint64(^uint32(0))
	if p.spanDays == 0 {
		return nil, fmt.Errorf("span-days must be positive, got 0")
	}
	// Codex review finding (Critical): check the pre-multiplication bound first —
	// p.spanDays * 86400 can overflow uint64 for a large enough spanDays, wrapping
	// to a small value that would then pass a post-multiplication uint32Max check
	// and silently produce a MaxSpan that doesn't match the operator's intent
	// (while the cost estimate below still uses the original, un-wrapped spanDays).
	if p.spanDays > uint32Max/86400 {
		return nil, fmt.Errorf("span-days %d exceeds the uint32 max_span range (max %d days)", p.spanDays, uint32Max/86400)
	}
	spanSeconds := p.spanDays * 86400
	if p.rateNanoPerMB == 0 {
		return nil, fmt.Errorf("rate-nano-per-mb-day must be positive, got 0")
	}
	if p.dataSizeBytes == 0 {
		return nil, fmt.Errorf("data size must be positive, got 0")
	}
	if p.pieceSize == 0 {
		return nil, fmt.Errorf("piece size must be positive, got 0")
	}

	rate := tlb.FromNanoTONU(p.rateNanoPerMB)
	// address.NewAddress(0, 0, providerPubkey) is not a real TON wallet — it's
	// how the reference CLI (tonutils-storage cli/main.go rentStorage) wraps a
	// provider's raw pubkey bytes to satisfy contract.ProviderV1.Address's Go
	// type; only .Data() (the pubkey bytes themselves) is ever serialized
	// on-chain (pkg/contract/v1.go PrepareV1DeployData). See main.go field notes.
	providers := []contract.ProviderV1{{
		Address:       address.NewAddress(0, 0, p.providerPubkey),
		MaxSpan:       uint32(spanSeconds),
		PricePerMBDay: rate,
	}}

	contractAddr, stateInit, body, err := contract.PrepareV1DeployData(
		p.bagID, p.merkleHash, p.dataSizeBytes, p.pieceSize, p.owner, providers,
	)
	if err != nil {
		return nil, fmt.Errorf("PrepareV1DeployData: %w", err)
	}

	siCell, err := tlb.ToCell(stateInit)
	if err != nil {
		return nil, fmt.Errorf("serialize StateInit: %w", err)
	}

	cost := storageCostNano(p.dataSizeBytes, p.rateNanoPerMB, p.spanDays)
	amount := new(big.Int).Add(cost, deployBufferNano)

	if p.maxSpendNano == nil {
		return nil, fmt.Errorf("internal: maxSpendNano is nil")
	}
	if amount.Cmp(p.maxSpendNano) > 0 {
		return nil, guardf(
			"computed amount %s nanoTON exceeds --max-spend-ton guard %s nanoTON — refusing to build the deploy",
			amount, p.maxSpendNano,
		)
	}

	bodyBOC := body.ToBOC()
	stateInitBOC := siCell.ToBOC()
	deeplink := buildDeployDeeplink(contractAddr, bodyBOC, stateInitBOC, amount, p.testnet)

	return &deployResult{
		contractAddr: contractAddr,
		stateInitBOC: stateInitBOC,
		bodyBOC:      bodyBOC,
		costNano:     cost,
		amountNano:   amount,
		deeplink:     deeplink,
	}, nil
}

// deployFlags holds the raw, as-parsed (but not yet cross-validated) flag
// values for `deploy`, before any seeder lookup or buildDeploy call.
type deployFlags struct {
	bagIDHex          string
	providerPubkeyRaw string
	ownerRaw          string
	rateRaw           string
	spanDaysRaw       string
	sizeBytesRaw      string
	pieceSizeRaw      string
	merkleHashRaw     string
	maxSpendTon       string
	mainnet           bool
}

func parseDeployFlagSet(args []string) (*deployFlags, error) {
	fs := newFlagSet("deploy")
	f := &deployFlags{}
	fs.StringVar(&f.bagIDHex, "bag-id", "", "bag id / torrent hash, 64 hex chars (required)")
	fs.StringVar(&f.providerPubkeyRaw, "provider-pubkey", "", "provider's ProviderKey (Ed25519) public key, 64 hex chars — mytonprovider.org's registry 'pubkey' field; NOT ADNLKey or a wallet address (required)")
	fs.StringVar(&f.ownerRaw, "owner", "", "raw owner wallet address (required)")
	fs.StringVar(&f.rateRaw, "rate-nano-per-mb-day", "", "nanoTON/MB/day (required)")
	fs.StringVar(&f.spanDaysRaw, "span-days", "", "proof span in days (required)")
	fs.StringVar(&f.sizeBytesRaw, "size-bytes", "", "bag size override (bytes)")
	fs.StringVar(&f.pieceSizeRaw, "piece-size", "", "piece size override (bytes)")
	fs.StringVar(&f.merkleHashRaw, "merkle-hash", "", "merkle root hash override, 64 hex chars")
	fs.StringVar(&f.maxSpendTon, "max-spend-ton", "0.5", "refuse if the suggested amount exceeds this many TON")
	fs.BoolVar(&f.mainnet, "mainnet", false, "opt in to mainnet (REAL FUNDS)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}
	return f, nil
}

// resolveDeployParams validates deployFlags and turns them into a
// deployParams, doing the seeder SSH lookup only when needed. This is the
// seam between the (untestable, network-touching) seeder path and the pure
// buildDeploy core: when --size-bytes/--piece-size/--merkle-hash are all
// three given, resolveDeployParams never touches the network, which is what
// deploy_test.go exploits for full offline `deploy` coverage.
func resolveDeployParams(ctx context.Context, f *deployFlags) (*deployParams, error) {
	if err := checkRequiredFlags("deploy",
		requiredFlag{"--bag-id <64hex>", f.bagIDHex},
		requiredFlag{"--provider-pubkey <64hex>", f.providerPubkeyRaw},
		requiredFlag{"--owner <raw-addr>", f.ownerRaw},
		requiredFlag{"--rate-nano-per-mb-day <int>", f.rateRaw},
		requiredFlag{"--span-days <int>", f.spanDaysRaw},
	); err != nil {
		return nil, err
	}

	bagID, err := parseHex32("--bag-id", f.bagIDHex)
	if err != nil {
		return nil, err
	}
	providerPubkey, err := parseHex32("--provider-pubkey", f.providerPubkeyRaw)
	if err != nil {
		return nil, err
	}
	owner, err := parseRawAddr("--owner", f.ownerRaw, 0, -1)
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

	overridesGiven := f.sizeBytesRaw != "" || f.pieceSizeRaw != "" || f.merkleHashRaw != ""
	overridesComplete := f.sizeBytesRaw != "" && f.pieceSizeRaw != "" && f.merkleHashRaw != ""
	if overridesGiven && !overridesComplete {
		return nil, fmt.Errorf(
			"--size-bytes, --piece-size, and --merkle-hash must be given together, or not at all " +
				"(got only some of them)",
		)
	}

	var dataSizeBytes uint64
	var pieceSize uint32
	var merkleHash []byte
	if overridesComplete {
		dataSizeBytes, err = parsePositiveUint64Flag("--size-bytes", f.sizeBytesRaw)
		if err != nil {
			return nil, err
		}
		pieceSizeU64, err := parsePositiveUint64Flag("--piece-size", f.pieceSizeRaw)
		if err != nil {
			return nil, err
		}
		if pieceSizeU64 > uint64(^uint32(0)) {
			return nil, fmt.Errorf("--piece-size %d exceeds uint32 range", pieceSizeU64)
		}
		pieceSize = uint32(pieceSizeU64)
		merkleHash, err = parseHex32("--merkle-hash", f.merkleHashRaw)
		if err != nil {
			return nil, err
		}
	} else {
		details, err := fetchSeederDetails(ctx, f.bagIDHex)
		if err != nil {
			return nil, fmt.Errorf(
				"resolving bag size/piece-size/merkle-hash from the seeder failed (pass all three of "+
					"--size-bytes/--piece-size/--merkle-hash to skip this): %w", err,
			)
		}
		dataSizeBytes = details.BagSizeBytes
		pieceSize = details.PieceSize
		merkleHash = details.MerkleHash
	}

	maxSpendCoins, err := tlb.FromTON(f.maxSpendTon)
	if err != nil {
		return nil, fmt.Errorf("--max-spend-ton must be a positive decimal number, got %q: %w", f.maxSpendTon, err)
	}
	maxSpendNano := maxSpendCoins.Nano()
	if maxSpendNano.Sign() <= 0 {
		return nil, fmt.Errorf("--max-spend-ton must be positive, got %q", f.maxSpendTon)
	}

	return &deployParams{
		bagID:          bagID,
		merkleHash:     merkleHash,
		dataSizeBytes:  dataSizeBytes,
		pieceSize:      pieceSize,
		owner:          owner,
		providerPubkey: providerPubkey,
		rateNanoPerMB:  rate,
		spanDays:       spanDays,
		maxSpendNano:   maxSpendNano,
		testnet:        !f.mainnet,
	}, nil
}

func runDeploy(ctx context.Context, args []string, stdout io.Writer) error {
	f, err := parseDeployFlagSet(args)
	if errIsHelp(err) {
		fmt.Fprint(stdout, subHelpText("deploy"))
		return nil
	}
	if err != nil {
		return err
	}

	p, err := resolveDeployParams(ctx, f)
	if err != nil {
		return err
	}

	if f.mainnet {
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "!! MAINNET MODE — REAL TON, REAL MONEY. Review the deeplink in your wallet !!")
		fmt.Fprintln(stdout, "!! before approving. There is no undo.                                    !!")
		fmt.Fprintln(stdout, "")
	}

	res, err := buildDeploy(*p)
	if err != nil {
		return err
	}

	network := "mainnet"
	if p.testnet {
		network = "testnet"
	}
	statusFlag := ""
	if f.mainnet {
		statusFlag = " --mainnet"
	}

	// issue #638: the StorageV1 contract ADDRESS is fully determined by
	// bagID/merkleHash/dataSize/pieceSize/owner (PrepareV1DeployData, called inside
	// buildDeploy above) -- NONE of which depend on --provider-pubkey/
	// --rate-nano-per-mb-day/--span-days. Re-running `deploy` for the SAME bag+owner
	// after an ambiguous or lost result (the operator never confirmed whether an
	// earlier Tonkeeper signature actually landed) therefore reproduces the IDENTICAL
	// address -- printing another deploy link here unconditionally would let the
	// operator sign and pay the storage cost for it a SECOND time. Check on-chain
	// BEFORE ever showing that link, mirroring update-providers.go's own precedent of
	// treating an unreadable tonapi state as a hard refusal (checkUpdateProvidersGasGuard's
	// neighboring runUpdateProviders check) rather than proceeding blind: this is a
	// human-reviewed, low-frequency, mainnet-money operation, so failing closed on an
	// unknown state is the safer default here (unlike ton-provider.ts's unattended
	// auto-sign path, which must fail OPEN on a check error so a single tonapi hiccup
	// can't wedge an automated nightly push — see that file's own comment on the same
	// trade-off).
	fmt.Fprintf(stdout, "checking on-chain state of %s (%s) before offering a deploy link ...\n", res.contractAddr.StringRaw(), network)
	acc, err := fetchAccountState(ctx, res.contractAddr, p.testnet)
	if err != nil {
		return fmt.Errorf(
			"could not fetch account state from tonapi — refusing to offer a deploy link for a contract whose "+
				"state is unknown (it may already be active, and deploying again would re-send the storage cost): %w",
			err,
		)
	}
	fmt.Fprintf(stdout, "  status: %s — %s\n", acc.Status, stateVerdict(acc.Status))
	// Codex review (xhigh pass): checking for literal "active" only left "uninit" (funded,
	// contract code not yet run — the exact few-second window right after a broadcast
	// lands) able to slip through and get funded a SECOND time; "frozen" (was deployed,
	// now suspended) is not a fresh address either. `nonexist` (no funds present at all)
	// is the ONLY status a genuinely first-time deploy should ever see here, so refuse on
	// anything else rather than allow-listing just "active".
	if acc.Status != "nonexist" {
		followUp := "use `update-providers` instead (gas-only, does NOT re-send the storage cost)"
		if acc.Status != "active" {
			followUp = fmt.Sprintf(
				"wait and re-run `status --contract %s%s` until it settles (tonapi may simply be lagging a recent "+
					"broadcast) before deciding what to do next",
				res.contractAddr.StringRaw(), statusFlag,
			)
		}
		return guardf(
			"contract %s is NOT a fresh address on %s (tonapi reports status=%q — %s) — deploying again would risk "+
				"sending another %.9f TON (%s nanoTON) to an address that may already hold funds. If it's already "+
				"active and you need to change or add a provider, %s; to inspect it directly, use "+
				"`status --contract %s%s`",
			res.contractAddr.StringRaw(), network, acc.Status, stateVerdict(acc.Status),
			nanoToFloat(res.amountNano), res.amountNano, followUp,
			res.contractAddr.StringRaw(), statusFlag,
		)
	}

	fmt.Fprintln(stdout, "== deploy ==")
	fmt.Fprintf(stdout, "  network:        %s\n", network)
	fmt.Fprintf(stdout, "  bag id:         %x\n", p.bagID)
	fmt.Fprintf(stdout, "  contract addr:  %s\n", res.contractAddr.StringRaw())
	fmt.Fprintf(stdout, "  provider pubkey: %x\n", p.providerPubkey)
	fmt.Fprintf(stdout, "  owner:          %s\n", p.owner.StringRaw())
	fmt.Fprintf(stdout, "  rate:           %d nanoTON/MB/day\n", p.rateNanoPerMB)
	fmt.Fprintf(stdout, "  span:           %d day(s)\n", p.spanDays)
	fmt.Fprintf(stdout, "  data size:      %d bytes\n", p.dataSizeBytes)
	fmt.Fprintf(stdout, "  piece size:     %d bytes\n", p.pieceSize)
	fmt.Fprintf(stdout, "  merkle hash:    %x\n", p.merkleHash)
	fmt.Fprintf(stdout, "  storage cost:   %.9f TON (%s nanoTON)\n", nanoToFloat(res.costNano), res.costNano)
	fmt.Fprintf(stdout, "  + deploy buffer: %.9f TON (%s nanoTON)\n", nanoToFloat(deployBufferNano), deployBufferNano)
	fmt.Fprintf(stdout, "  = amount:       %.9f TON (%s nanoTON)\n", nanoToFloat(res.amountNano), res.amountNano)
	fmt.Fprintf(stdout, "  deeplink:       %s\n", res.deeplink)
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "Review the amount + recipient in your wallet BEFORE approving.")
	fmt.Fprintln(stdout, "After signing, confirm it landed with:")
	fmt.Fprintf(stdout, "  storage-v1-client status --contract %s%s\n", res.contractAddr.StringRaw(), statusFlag)
	fmt.Fprintln(stdout, "then tell the provider it exists with:")
	fmt.Fprintf(stdout, "  storage-v1-client notify --provider-pubkey %x --contract %s%s\n",
		p.providerPubkey, res.contractAddr.StringRaw(), statusFlag)
	return nil
}

func nanoToFloat(n *big.Int) float64 {
	f := new(big.Float).SetInt(n)
	f.Quo(f, big.NewFloat(1e9))
	out, _ := f.Float64()
	return out
}
