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

// withdraw sends withdraw_owner#61fff683 (contract.PrepareWithdrawalRequest,
// the exact upstream function — not a reimplementation) to an
// ALREADY-DEPLOYED StorageV1 contract. Per the on-chain handler
// (xssnick/tonutils-contracts storage-contract.fc, op::withdraw_owner):
// checks sender == the contract's own OwnerAddr, reserves only the storage
// fee, and sends the ENTIRE remaining balance back to the owner along with
// storage_contract_terminated — this PERMANENTLY ends the contract's proof
// cycle. There is no partial withdrawal and no undo.
//
// PrepareWithdrawalRequest independently re-derives the contract address
// from the SAME (bagID, merkleHash, dataSizeBytes, pieceSize, ownerAddr)
// StateInit hash 'deploy' uses (see v1.go — the provider list plays no part
// in the address). buildWithdraw cross-checks that derived address against
// --contract as a guardrail: a mismatch means the caller passed bag/owner
// details that don't actually describe the contract they think they're
// withdrawing from, and this refuses rather than building a deeplink for the
// wrong account.
type withdrawParams struct {
	contract      *address.Address
	bagID         []byte // 32 bytes — StorageV1.TorrentHash
	merkleHash    []byte // 32 bytes — StorageV1.MerkleHash
	dataSizeBytes uint64
	pieceSize     uint32
	owner         *address.Address
	gasNano       *big.Int
	maxSpendNano  *big.Int
	testnet       bool
}

type withdrawResult struct {
	bodyBOC  []byte
	deeplink string
}

// buildWithdraw is the pure, network-free core of `withdraw` — mirrors
// buildUpdateProvidersBody/buildDeploy in taking already-validated inputs
// and returning a deeplink, with no network access of its own.
func buildWithdraw(p withdrawParams) (*withdrawResult, error) {
	if len(p.bagID) != 32 {
		return nil, fmt.Errorf("bag id must be 32 bytes, got %d", len(p.bagID))
	}
	if len(p.merkleHash) != 32 {
		return nil, fmt.Errorf("merkle hash must be 32 bytes, got %d", len(p.merkleHash))
	}
	if p.dataSizeBytes == 0 {
		return nil, fmt.Errorf("data size must be positive, got 0")
	}
	if p.pieceSize == 0 {
		return nil, fmt.Errorf("piece size must be positive, got 0")
	}

	derivedAddr, body, err := contract.PrepareWithdrawalRequest(
		p.bagID, p.merkleHash, p.dataSizeBytes, p.pieceSize, p.owner,
	)
	if err != nil {
		return nil, fmt.Errorf("PrepareWithdrawalRequest: %w", err)
	}
	if !derivedAddr.Equals(p.contract) {
		return nil, guardf(
			"the given --bag-id/--merkle-hash/--size-bytes/--piece-size/--owner derive contract "+
				"address %s, which does NOT match --contract %s — refusing to build a withdrawal for "+
				"the wrong account (check these values against 'deploy's own output for this contract)",
			derivedAddr.StringRaw(), p.contract.StringRaw(),
		)
	}

	if p.gasNano == nil {
		return nil, fmt.Errorf("internal: gasNano is nil")
	}
	if p.maxSpendNano == nil {
		return nil, fmt.Errorf("internal: maxSpendNano is nil")
	}
	if p.gasNano.Cmp(p.maxSpendNano) > 0 {
		return nil, guardf(
			"--gas-ton %s nanoTON exceeds --max-spend-ton guard %s nanoTON — refusing to build the withdrawal",
			p.gasNano, p.maxSpendNano,
		)
	}

	bodyBOC := body.ToBOC()
	deeplink := buildUpdateProvidersDeeplink(p.contract, bodyBOC, p.gasNano, p.testnet)

	return &withdrawResult{bodyBOC: bodyBOC, deeplink: deeplink}, nil
}

type withdrawFlags struct {
	contractRaw   string
	bagIDHex      string
	merkleHashRaw string
	sizeBytesRaw  string
	pieceSizeRaw  string
	ownerRaw      string
	gasTon        string
	maxSpendTon   string
	mainnet       bool
}

func parseWithdrawFlags(args []string) (*withdrawParams, error) {
	fs := newFlagSet("withdraw")
	f := &withdrawFlags{}
	fs.StringVar(&f.contractRaw, "contract", "", "the ALREADY-DEPLOYED StorageV1 contract's raw address (required)")
	fs.StringVar(&f.bagIDHex, "bag-id", "", "bag id / torrent hash, 64 hex chars — must match what this contract was deployed with (required)")
	fs.StringVar(&f.merkleHashRaw, "merkle-hash", "", "merkle root hash, 64 hex chars — must match this contract's deploy (required)")
	fs.StringVar(&f.sizeBytesRaw, "size-bytes", "", "bag size in bytes — must match this contract's deploy (required)")
	fs.StringVar(&f.pieceSizeRaw, "piece-size", "", "piece size in bytes — must match this contract's deploy (required)")
	fs.StringVar(&f.ownerRaw, "owner", "", "raw owner wallet address — must be the SAME wallet selected/active when signing, and must match this contract's OwnerAddr (required)")
	fs.StringVar(&f.gasTon, "gas-ton", "0.05", "TON attached for message-processing gas only — the contract's ENTIRE remaining balance is returned to --owner on top of this")
	fs.StringVar(&f.maxSpendTon, "max-spend-ton", "0.1", "refuse if --gas-ton would exceed this many TON")
	fs.BoolVar(&f.mainnet, "mainnet", false, "opt in to mainnet (REAL FUNDS)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}

	if f.contractRaw == "" {
		return nil, fmt.Errorf("withdraw requires --contract <raw-addr>")
	}
	contractAddr, err := parseRawAddr("--contract", f.contractRaw, 0, -1)
	if err != nil {
		return nil, err
	}
	if f.bagIDHex == "" {
		return nil, fmt.Errorf("withdraw requires --bag-id <64hex>")
	}
	bagID, err := parseHex32("--bag-id", f.bagIDHex)
	if err != nil {
		return nil, err
	}
	if f.merkleHashRaw == "" {
		return nil, fmt.Errorf("withdraw requires --merkle-hash <64hex>")
	}
	merkleHash, err := parseHex32("--merkle-hash", f.merkleHashRaw)
	if err != nil {
		return nil, err
	}
	if f.sizeBytesRaw == "" {
		return nil, fmt.Errorf("withdraw requires --size-bytes <n>")
	}
	dataSizeBytes, err := parsePositiveUint64Flag("--size-bytes", f.sizeBytesRaw)
	if err != nil {
		return nil, err
	}
	if f.pieceSizeRaw == "" {
		return nil, fmt.Errorf("withdraw requires --piece-size <n>")
	}
	pieceSizeU64, err := parsePositiveUint64Flag("--piece-size", f.pieceSizeRaw)
	if err != nil {
		return nil, err
	}
	if pieceSizeU64 > uint64(^uint32(0)) {
		return nil, fmt.Errorf("--piece-size %d exceeds uint32 range", pieceSizeU64)
	}
	if f.ownerRaw == "" {
		return nil, fmt.Errorf("withdraw requires --owner <raw-addr>")
	}
	owner, err := parseRawAddr("--owner", f.ownerRaw, 0, -1)
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

	return &withdrawParams{
		contract:      contractAddr,
		bagID:         bagID,
		merkleHash:    merkleHash,
		dataSizeBytes: dataSizeBytes,
		pieceSize:     uint32(pieceSizeU64),
		owner:         owner,
		gasNano:       gasNano,
		maxSpendNano:  maxSpendNano,
		testnet:       !f.mainnet,
	}, nil
}

func runWithdraw(ctx context.Context, args []string, stdout io.Writer) error {
	p, err := parseWithdrawFlags(args)
	if errIsHelp(err) {
		fmt.Fprint(stdout, helpText)
		return nil
	}
	if err != nil {
		return err
	}

	network := "mainnet"
	if p.testnet {
		network = "testnet"
	}
	fmt.Fprintf(stdout, "checking on-chain state of %s (%s) before withdrawing ...\n", p.contract.StringRaw(), network)
	acc, err := fetchAccountState(ctx, p.contract, p.testnet)
	if err != nil {
		return fmt.Errorf("could not fetch account state from tonapi — refusing to build a withdrawal for a contract whose state is unknown: %w", err)
	}
	fmt.Fprintf(stdout, "  status: %s — %s\n", acc.Status, stateVerdict(acc.Status))
	if acc.Status != "active" {
		return guardf(
			"contract %s status is %q, not 'active' — withdraw is only meaningful against a deployed, running contract",
			p.contract.StringRaw(), acc.Status,
		)
	}
	fmt.Fprintf(stdout, "  current balance: %.9f TON — this ENTIRE amount (minus a small storage-fee reserve) will be returned to --owner\n", float64(acc.Balance)/1e9)

	res, err := buildWithdraw(*p)
	if err != nil {
		return err
	}

	if !p.testnet {
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "!! MAINNET MODE — REAL TON, REAL MONEY. Review the deeplink in your wallet !!")
		fmt.Fprintln(stdout, "!! before approving. There is no undo.                                    !!")
		fmt.Fprintln(stdout, "")
	}

	fmt.Fprintln(stdout, "== withdraw (PERMANENTLY terminates this contract) ==")
	fmt.Fprintf(stdout, "  network:         %s\n", network)
	fmt.Fprintf(stdout, "  contract addr:   %s\n", p.contract.StringRaw())
	fmt.Fprintf(stdout, "  owner:           %s (must be the wallet ACTIVE/SELECTED in Tonkeeper when signing)\n", p.owner.StringRaw())
	fmt.Fprintf(stdout, "  gas attached:    %.9f TON (%s nanoTON)\n", nanoToFloat(p.gasNano), p.gasNano)
	fmt.Fprintf(stdout, "  deeplink:        %s\n", res.deeplink)
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "WARNING: this ends the contract's proof cycle permanently — any provider")
	fmt.Fprintln(stdout, "currently serving this bag under this contract will no longer be paid for it.")
	fmt.Fprintln(stdout, "Review the amount + recipient in your wallet BEFORE approving.")
	statusFlag := ""
	if !p.testnet {
		statusFlag = " --mainnet"
	}
	fmt.Fprintf(stdout, "After signing, confirm the payout with:\n  storage-v1-client status --contract %s%s\n",
		p.contract.StringRaw(), statusFlag)
	return nil
}
