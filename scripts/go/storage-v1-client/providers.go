package main

// providers: read the StorageV1 contract's OWN on-chain provider set — the
// `ActiveProviders` dict inside its account state — and print it as JSON.
//
// Why this exists (issue #665, authority "(b)"): when cypher-brain retries a
// push whose contract is ALREADY funded on-chain, it must notify whichever
// provider that contract was actually deployed with, not whichever one this
// run's mytonprovider.org snapshot happens to return. #824 shipped authority
// (a) — resume from this machine's own durable records (the pending-spend
// intent, else the #654 receipt) — which cannot answer at all for a contract
// this machine has no record of. The contract itself always can, and it is
// the only source that outranks a local note: `modify_providers` REPLACES the
// dict rather than merging into it, so what the chain holds now IS the
// registration, whatever an older local record says.
//
// How it reads it, and why not a get-method run. StorageV1 does expose a
// `get_providers` get-method (contract.GetProvidersV1, pkg/contract/v1.go),
// but every upstream caller of it needs a ton.APIClientWrapped — a liteserver
// connection plus a global config — which this program deliberately does not
// have (see main.go: every on-chain READ here is a single tonapi HTTP GET, on
// purpose). tonapi's account endpoint already returns the account's raw `data`
// cell, and that cell IS the state a get-method would be computing its answer
// from, decoded here with the SAME upstream TL-B layout the deploy path
// already depends on (contract.StorageV1). So this is one more read of
// something already available over the transport this program already uses,
// not a second way of talking to the chain.
//
// Exit codes follow the taxonomy #750 settled for every other subcommand: 2
// for a deliberate on-chain-safety REFUSAL (the account is not 'active', so it
// holds no provider dict to read), 1 for anything that failed (tonapi
// unreachable, malformed response, a data cell that is not a StorageV1), and 0
// for a successful read — including a successful read of an EMPTY dict, which
// is a real answer ("this contract currently names no provider"), not a
// failure. A caller must not be able to confuse "could not read" with "read,
// and it names nobody": the first leaves an earlier authority in charge, the
// second is itself authoritative.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tlb"
	"github.com/xssnick/tonutils-go/tvm/cell"
	"github.com/xssnick/tonutils-storage-provider/pkg/contract"
)

// onchainProvider is one entry of the contract's ActiveProviders dict.
//
// `pubkey` is the dict KEY, and it is the field this subcommand exists for:
// it is the provider's ProviderKey (Ed25519) public key, the same 64-hex value
// deploy/notify/update-providers all take as --provider-pubkey (see main.go's
// field notes for why that, and not a wallet address, is the on-chain
// identity).
//
// `terms` carries the max_span/rate the contract currently holds for that
// provider. It is nullable ON PURPOSE. The dict VALUE a live contract stores
// is richer than the one `modify_providers` sends: measured against a real
// mainnet StorageV1 account (2026-09-02), the value is 160 inline bits plus
// ONE ref, where the ref is exactly the {max_span:uint32, rate:Coins} pair
// this repo already builds in buildUpdateProvidersBody, and the 160 inline
// bits are the contract's own per-provider runtime bookkeeping (byte-to-prove,
// last-proof time, proof nonce — in an order no written spec pins down, so it
// is NOT decoded and NOT reported here rather than guessed at and printed as
// if it were known). If the ref is absent or does not decode, `terms` is null
// and the entry still reports its pubkey — losing the terms must not lose the
// identity, which is the answer the caller actually needs.
type onchainProvider struct {
	Pubkey string        `json:"pubkey"`
	Terms  *onchainTerms `json:"terms"`
}

type onchainTerms struct {
	MaxSpanSeconds   uint64 `json:"max_span_seconds"`
	RateNanoPerMBDay string `json:"rate_nano_per_mb_day"` // decimal string: Coins is arbitrary-precision, and a float would round it
}

type providersOutput struct {
	Address   string            `json:"address"`
	Network   string            `json:"network"`
	Status    string            `json:"status"`
	Providers []onchainProvider `json:"providers"`
}

type providersParams struct {
	contract *address.Address
	testnet  bool
}

func parseProvidersFlags(args []string) (*providersParams, error) {
	fs := newFlagSet("providers")
	// --address, not --contract: the sibling subcommands' --contract names the
	// contract to ACT on, while this one only reads it, and the JSON field it
	// prints back is `address`. Documented in providersHelp so an operator who
	// knows the other five is not left guessing.
	addressFlag := fs.String("address", "", "deployed StorageV1 contract address (raw, required)")
	mainnet := fs.Bool("mainnet", false, "opt in to mainnet")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}
	if *addressFlag == "" {
		return nil, fmt.Errorf("providers requires --address <raw-addr>")
	}
	addr, err := parseRawAddr("--address", *addressFlag, 0, -1)
	if err != nil {
		return nil, err
	}
	return &providersParams{contract: addr, testnet: !*mainnet}, nil
}

// decodeActiveProviders turns a StorageV1 account's raw `data` cell into the
// provider list. Pure (no network) so the whole decode — including every
// malformed-input branch — is unit-testable without an HTTP round trip.
func decodeActiveProviders(dataHex string) ([]onchainProvider, error) {
	if dataHex == "" {
		return nil, fmt.Errorf("tonapi returned no `data` cell for this account, so its provider dict cannot be read")
	}
	raw, err := hex.DecodeString(dataHex)
	if err != nil {
		return nil, fmt.Errorf("tonapi's `data` field is not hex: %w", err)
	}
	root, err := cell.FromBOC(raw)
	if err != nil {
		return nil, fmt.Errorf("tonapi's `data` field is not a valid BOC: %w", err)
	}
	slice, err := root.BeginParse()
	if err != nil {
		return nil, fmt.Errorf("could not read the account's data cell: %w", err)
	}
	var st contract.StorageV1
	if err := tlb.LoadFromCell(&st, slice); err != nil {
		// The likeliest cause by far is that --address is not a StorageV1
		// contract at all (a wallet, an NFT item, ...), so say so instead of
		// surfacing a bare TL-B parse error.
		return nil, fmt.Errorf("this account's data cell does not parse as a StorageV1 contract (is --address really a StorageV1 contract?): %w", err)
	}
	// A nil/empty dict is not an error: a contract can legitimately name no
	// provider (deployed with an empty modify_providers, or one that replaced
	// its list with nothing). Report it as the empty list it is.
	if st.ActiveProviders == nil {
		return []onchainProvider{}, nil
	}
	kvs, err := st.ActiveProviders.LoadAll()
	if err != nil {
		return nil, fmt.Errorf("could not walk the contract's ActiveProviders dict: %w", err)
	}
	out := make([]onchainProvider, 0, len(kvs))
	for _, kv := range kvs {
		key, err := kv.Key.LoadBigUInt(256)
		if err != nil {
			return nil, fmt.Errorf("could not read an ActiveProviders dict key: %w", err)
		}
		pubkey := make([]byte, 32)
		key.FillBytes(pubkey) // left-pads: a key with leading zero bytes is still a 32-byte pubkey
		out = append(out, onchainProvider{Pubkey: hex.EncodeToString(pubkey), Terms: decodeProviderTerms(kv.Value)})
	}
	return out, nil
}

// decodeProviderTerms reads the {max_span:uint32, rate:Coins} pair the live
// contract keeps in the dict value's ref — the same pair
// buildUpdateProvidersBody writes into a modify_providers body. Best-effort by
// design (see onchainProvider's comment): a shape this does not recognize
// yields nil rather than failing the whole read, because the pubkey above is
// the authoritative answer and must survive an unreadable terms cell.
func decodeProviderTerms(value *cell.Slice) *onchainTerms {
	if value == nil || value.RefsNum() == 0 {
		return nil
	}
	ref, err := value.LoadRef()
	if err != nil {
		return nil
	}
	span, err := ref.LoadUInt(32)
	if err != nil {
		return nil
	}
	rate, err := ref.LoadBigCoins()
	if err != nil || rate == nil {
		return nil
	}
	return &onchainTerms{MaxSpanSeconds: span, RateNanoPerMBDay: new(big.Int).Set(rate).String()}
}

func runProviders(ctx context.Context, args []string, stdout io.Writer) error {
	p, err := parseProvidersFlags(args)
	if errIsHelp(err) {
		fmt.Fprint(stdout, subHelpText("providers"))
		return nil
	}
	if err != nil {
		return err
	}

	network := "mainnet"
	if p.testnet {
		network = "testnet"
	}
	acc, err := fetchAccountState(ctx, p.contract, p.testnet)
	if err != nil {
		return fmt.Errorf("could not fetch account state from tonapi: %w", err)
	}
	// Only an 'active' account has run its code, and only code that has run
	// can hold a merged ActiveProviders dict — 'nonexist'/'uninit'/'frozen'
	// have nothing to read. Refusing (exit 2) rather than printing an empty
	// list keeps the two apart for a caller that branches on them: an empty
	// list from an active contract MEANS "nobody is registered", and must not
	// be produced by an account that simply has not run yet.
	if acc.Status != "active" {
		return guardf(
			"contract %s status is %q on %s, not 'active' — it holds no provider dict to read (%s)",
			p.contract.StringRaw(), acc.Status, network, stateVerdict(acc.Status),
		)
	}
	providers, err := decodeActiveProviders(acc.Data)
	if err != nil {
		return err
	}

	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(providersOutput{
		Address:   p.contract.StringRaw(),
		Network:   network,
		Status:    acc.Status,
		Providers: providers,
	})
}
