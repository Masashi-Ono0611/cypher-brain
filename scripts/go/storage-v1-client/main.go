// Command storage-v1-client is an operator-run, EXPERIMENTAL Go program that
// talks the *live* TON Storage third-party provider market — the Go
// ("StorageV1") ecosystem, registry mytonprovider.org — as opposed to the
// legacy C++ ("fabric contract") ecosystem that
// scripts/ton-provider-experiment.mjs already speaks (see that script's own
// header, and docs/ton-storage-status.md "the provider market is TWO
// incompatible ecosystems"). This program is deliberately NOT a CLI feature:
// it lives outside src/, changes nothing shipped, and has its own go.mod so
// cypher-brain's shipped runtime dependencies are untouched.
//
// Unlike the C++ scheme (provider-deployed fabric contract, client "offers"
// into it), the Go/StorageV1 scheme has the CLIENT deploy a per-bag contract
// itself — this program builds that deploy (StateInit + modify_providers
// body + a suggested TON amount) and prints a Tonkeeper transfer deeplink,
// exactly the way the upstream reference CLI does it. It never touches a
// private key: every on-chain action is a deeplink for a human to review and
// sign in their own wallet.
//
// Ported (faithfully, with credit) from two upstream repositories:
//
// github.com/xssnick/tonutils-storage-provider (v0.4.3):
//
//	pkg/contract/v1.go — StorageV1 TL-B layout, V1Code (compiled contract
//	code BOC), and PrepareV1DeployData, which builds the StateInit data
//	cell + modify_providers body and derives the contract address from
//	the StateInit hash. This is the exact function this program calls
//	for `deploy` — not a reimplementation.
//
//	pkg/transport/client.go — Client.RequestStorageInfo: the ADNL/RLDP
//	"storageProvider.storageRequest" query that tells a provider daemon
//	a contract exists for it to check. This program calls it directly
//	for `notify`.
//
// github.com/xssnick/tonutils-storage (v1.5.3):
//
//	provider/provider.go — provider.Client.BuildAddProviderTransaction,
//	the function the upstream tonutils-storage CLI's own "rent-storage"
//	REPL command uses. It is a thin wrapper around PrepareV1DeployData
//	(adding the target provider(s) to the modify_providers dict included
//	in the SAME deploy message — see "field notes" below) plus BOC
//	serialization. This program's deploy.go inlines that same wrapping
//	directly against pkg/contract, since BuildAddProviderTransaction
//	itself requires a running local tonutils-storage daemon (via
//	*db.Storage) that this standalone experiment does not have.
//
//	cli/main.go — the "rent-storage" REPL command: confirms the exact
//	Tonkeeper deeplink shape
//	(ton://transfer/<addr>?bin=<b64>&init=<b64>&amount=<n>, using padded
//	base64.URLEncoding) this program reproduces byte-for-byte in
//	deeplink.go.
//
// Field notes (verified against the above source, 2026-08-23):
//   - StorageV1's on-chain STATE starts with an EMPTY ActiveProviders dict —
//     PrepareV1DeployData's `data` cell never sets it. The target provider is
//     instead carried in the SEPARATE modify_providers (0x3dc680ae) message
//     BODY sent alongside the deploy in the same external message; the
//     contract merges it into ActiveProviders when it first runs. `deploy`
//     always includes exactly the one --provider-pubkey given.
//   - Funding + deploying on-chain does NOT by itself make a provider daemon
//     aware of the contract (internal/service/startup_wallet_scan.go and
//     stopped_reconciler.go only re-check contracts a provider ALREADY
//     accepted — they are not a new-contract discovery path, and they are
//     unexported `internal/` code this program cannot import anyway). The
//     only new-contract discovery path is the ADNL push `notify` sends.
//   - SECOND CORRECTION (2026-08-23, this one found via a REAL mainnet
//     incident — a live deploy + notify against a real provider; see the fix
//     commit and docs/ton-storage-status.md for the full account): the FIRST
//     correction above (which split --provider into a wallet address for
//     deploy vs. a pubkey for notify) was ITSELF wrong. `ProviderV1.Address`
//     is not a real TON wallet at all — `address.NewAddress(0, 0, pubkey)` is
//     just how the Go SDK's dict-key API wants the type shaped; only
//     `.Data()` (the raw pubkey bytes) is ever serialized on-chain
//     (pkg/contract/v1.go PrepareV1DeployData: `providersDict.SetIntKey(new(
//     big.Int).SetBytes(provider.Address.Data()), ...)`). Proof: the
//     contract's proof_storage handler runs `check_signature(...,
//     signature, key)` against that same dict key — a wallet address (a
//     StateInit hash) cannot satisfy an Ed25519 signature check; only the
//     signing key's own public half can. The daemon looks itself up via
//     `s.key.Public()` (its ProviderKey, internal/service/service.go
//     FetchStorageInfo), and the reference CLI (tonutils-storage cli/main.go
//     rentStorage) passes the SAME pubkey bytes to both the ADNL rate query
//     and the on-chain Address field — never a wallet address. A wallet IS
//     derived from the same ProviderKey (`wallet.FromPrivateKey(api,
//     cfg.ProviderKey, wallet.V3R2)`, cmd/main.go), which is why the two
//     32-byte values can look related without being identical — that
//     wallet exists to send proof transactions and receive payouts, and is
//     unrelated to the on-chain dict key. **Both `deploy --provider-pubkey`
//     and `notify --provider-pubkey` therefore take the SAME value:
//     mytonprovider.org's registry `pubkey` field** (not its `address`
//     field). No official TON.org doc states this in prose; it is
//     established by the contract's own signature check plus consistent
//     reference-CLI and daemon behavior, which a from-scratch web+source
//     review (2026-08-23) called "effectively definitive" despite the
//     absence of an explicit written spec.
//   - Money-safety note from the same incident: getting this field wrong
//     does NOT lose funds. StorageV1 pays proof rewards to whichever address
//     SENDS a valid signed proof message, not to the dictionary key itself —
//     a contract with the wrong key installed just sits inert (the intended
//     provider daemon can never find itself, so it never proves, so it never
//     gets paid, but the contract's balance stays put under the owner's
//     control). It is also repairable in place: `providers` never touches
//     the StateInit `data` cell (only bagID/merkleHash/dataSize/pieceSize/
//     ownerAddr do — see PrepareV1DeployData above), so re-deriving the
//     contract address with a corrected provider list reproduces the exact
//     same live address. `update-providers` (updateproviders.go) sends a
//     bare modify_providers message to that existing address to fix it,
//     without a new deploy.
//   - mytonprovider.org's registry `price` field is NOT the raw
//     rate_per_mb_day the contract wants — it is
//     rate_per_mb_day * 1024 * 200 * 30 (a 200 GB/30-day cost estimate).
//     Divide by that same constant to recover --rate-nano-per-mb-day. This
//     program does not call the registry itself (kept out of scope — see
//     --help); the operator resolves the rate externally and passes it in.
//
// THIS PROGRAM NEVER TOUCHES YOUR WALLET'S PRIVATE KEY. `deploy` only prints
// a Tonkeeper deeplink for a human to review and sign — no funds move without
// that signature. `notify` and `status` move no funds either, but are not
// otherwise both "read-only": `status` is a plain read-only HTTP GET;
// `notify` generates its own ephemeral, throwaway Ed25519 keypair (used only
// to open an ADNL/RLDP session — it is not your wallet key, is never
// persisted, and is discarded when the process exits) and sends a real
// request that a live provider daemon acts on (it starts downloading/
// checking the bag) — a genuine remote side effect, even though it costs no
// TON and needs no signature.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
)

const helpText = `storage-v1-client — operator-run EXPERIMENTAL client for the live TON
Storage Go/StorageV1 provider market (registry: mytonprovider.org).

This is NOT a cypher-brain CLI feature — see the top-of-file comment in
main.go for what it is, what it is ported from, and its field notes.
It never touches your wallet's private key: 'deploy' prints a Tonkeeper
transfer deeplink for a human to review and sign. 'status' is a read-only
network call; 'notify' moves no funds and needs no signature, but is NOT
read-only — it sends a real ADNL request a live provider daemon acts on (see
the top-of-file comment for detail on its own throwaway session key).

Usage:
  storage-v1-client deploy --bag-id <64hex> --provider-pubkey <64hex> \
      --rate-nano-per-mb-day <int> --span-days <int> --owner <raw-addr> \
      [--size-bytes <n> --piece-size <n> --merkle-hash <64hex>] \
      [--mainnet] [--max-spend-ton 0.5]
  storage-v1-client notify --provider-pubkey <64hex> --contract <raw-addr> \
      [--mainnet] [--byte-to-proof <uint64>] [--timeout <seconds>]
  storage-v1-client status --contract <raw-addr> [--mainnet]
  storage-v1-client update-providers --contract <raw-addr> \
      --provider-pubkey <64hex> --rate-nano-per-mb-day <int> --span-days <int> \
      [--gas-ton 0.05] [--mainnet] [--max-spend-ton 0.1]
  storage-v1-client --help

deploy: derives the StorageV1 contract address, builds its StateInit + the
modify_providers deploy body (with --provider-pubkey already included — see
the "field notes" in main.go), computes a suggested funding amount, and
prints a Tonkeeper deeplink. Refuses (exit 2) if the computed amount exceeds
--max-spend-ton.

  --bag-id <64hex>          required. The bag's TON Storage torrent hash
                             (== StorageV1.TorrentHash). This is the same
                             64-hex value as a cypher-brain "ton:v1:<hex>"
                             locator's suffix.
  --provider-pubkey <64hex> required. The provider's ADNL/Ed25519 public key
                             — mytonprovider.org's registry 'pubkey' field
                             (NOT its 'address' field — see main.go field
                             notes: this is the same value 'notify' below
                             takes, not a TON wallet address, despite
                             ProviderV1.Address's Go type name).
  --owner <raw-addr>        required. Raw TON address ("0:<64hex>" or
                             "-1:<64hex>") that will own the contract
                             (StorageV1.OwnerAddr) — normally your own wallet.
  --rate-nano-per-mb-day <int>  required. nanoTON/MB/day the provider charges.
                             NOTE: mytonprovider.org's registry 'price' field
                             is NOT this value directly — see main.go field
                             notes for the conversion.
  --span-days <int>         required. Proof span, in days (converted to
                             seconds for StorageV1.MaxSpan — must fit uint32).
  --size-bytes <n>          bag size in bytes (StorageV1.DataSize). Must be
                             given together with --piece-size and
                             --merkle-hash, or not at all.
  --piece-size <n>          bag piece/chunk size in bytes (StorageV1.PieceSize).
                             Must be given together with --size-bytes and
                             --merkle-hash, or not at all.
  --merkle-hash <64hex>     the torrent's merkle root hash
                             (StorageV1.MerkleHash) — NOT the same value as
                             --bag-id (see main.go field notes: TorrentHash is
                             the TorrentInfo cell's own hash; MerkleHash is a
                             field inside that cell). Must be given together
                             with --size-bytes and --piece-size, or not at all.
  --mainnet                 opt in to mainnet (REAL FUNDS). Default: testnet.
  --max-spend-ton <float>   refuse (exit 2) if the suggested CONTRACT-DEPLOY
                             TRANSFER amount would exceed this. Default 0.5.
                             Compared as nanoTON (big.Int), never as a float.
                             Does NOT include wallet/network gas fees, which
                             your wallet app adds on top when you sign — the
                             actual amount your wallet debits will be
                             somewhat higher than this cap.

  When --size-bytes/--piece-size/--merkle-hash are NOT all three given, this
  program resolves them by asking cypher-brain's own seeder (the same
  tonutils-storage daemon this repo already runs — src/lib/backends/ton.ts)
  for its /api/v1/details of the bag, over SSH — mirroring
  scripts/ton-provider-experiment.mjs's getBagSizeBytesFromSeeder, extended
  to also read piece_size and merkle_hash (both exposed by that same
  endpoint — see api/api.go in xssnick/tonutils-storage, handleDetails).

Env (deploy, only when the three overrides above are not all given):
  CYPHER_BRAIN_TON_SSH_HOST   (required) user@host of the seeder
  CYPHER_BRAIN_TON_SSH_KEY    (optional) -i identity file for ssh
  CYPHER_BRAIN_TON_REMOTE_API (optional) tonutils-storage API addr on the
                               seeder, default 127.0.0.1:9955

notify: sends the ADNL/RLDP "storageProvider.storageRequest" query that is
the ONLY way (per main.go field notes) a provider daemon learns of a
newly-deployed contract. Before querying, this checks --contract's on-chain
account state via tonapi (read-only HTTP) and REFUSES (exit 2) if the
account is 'nonexist' (nothing deployed there yet — notifying would be
meaningless). If the state is anything other than 'active' it warns but
proceeds. Run this ONLY after --contract has actually landed on-chain from a
signed 'deploy' deeplink — querying too early wastes the round trip and this
program cannot distinguish "not yet confirmed" from "never happened".

  --provider-pubkey <64hex> required. The provider's ADNL/Ed25519 public key
                             — mytonprovider.org's registry 'pubkey' field.
                             Same value 'deploy' and 'update-providers' take
                             (see main.go field notes).
  --contract <raw-addr>     required. The deployed StorageV1 contract address
                             (printed by 'deploy', or found in your wallet
                             history / tonviewer after signing).
  --byte-to-proof <uint64>  which byte offset to ask the provider to prove
                             (see main.go). Default 0 — always in-range
                             regardless of bag size, appropriate for a fresh
                             notify.
  --timeout <seconds>       ADNL/DHT operation timeout. Default 20.
  --mainnet                 opt in to mainnet. Default: testnet.

  UNVERIFIED IN THIS SESSION: DHT resolution and the RLDP query have not been
  exercised against a live provider daemon — see the completion report for
  what that would require. Everything through 'go build'/'go test' (DHT
  client construction, ADNL gateway startup, argument validation) is
  exercised; the actual network round trip is not.

status: queries tonapi for --contract's on-chain account state. Read-only,
informational — mirrors scripts/ton-provider-experiment.mjs's 'status'
subcommand, EXCEPT it exits 1 (not 0) if the tonapi query itself fails
(timeout/HTTP error/malformed response), so an automated caller checking
only the exit code cannot mistake "could not check" for "checked, looks
fine". The on-chain STATE ITSELF is still never judged pass/fail — a
successfully-observed 'nonexist'/'uninit'/'frozen' state still exits 0. Does
NOT decode whether a provider accepted the contract, only whether it exists
on-chain and its balance.

  --contract <raw-addr>     required.
  --mainnet                 opt in to mainnet. Default: testnet.

update-providers: REPAIR path for an ALREADY-DEPLOYED contract whose provider
list is wrong or needs changing — sends a bare modify_providers message (no
StateInit, same contract address, existing balance untouched) instead of a
new deploy. Added 2026-08-23 after a real incident: 'deploy' (before that
fix) accepted a provider's TON wallet address instead of its pubkey, so the
provider daemon could never find itself in the contract. Confirmed the
contract's data cell (which determines its address) never depends on the
provider list, so this repairs in place — see main.go field notes.
REFUSES (exit 2) if --contract is 'nonexist' (use 'deploy' for a new
contract instead).

  IMPORTANT: this REPLACES the entire on-chain provider list with the single
  entry given here, not a merge — any other providers already on the
  contract would be dropped by this call.

  --contract <raw-addr>         required. The EXISTING contract's address.
  --provider-pubkey <64hex>     required. Same semantics as 'deploy'/'notify'
                                 above.
  --rate-nano-per-mb-day <int>  required. See 'deploy' — same conversion note
                                 applies for mytonprovider.org's 'price' field.
  --span-days <int>             required. See 'deploy'.
  --gas-ton <float>              TON attached for message-processing gas only
                                 — NOT a re-funding of the storage budget (the
                                 contract keeps its existing balance). Default
                                 0.05.
  --max-spend-ton <float>       refuse (exit 2) if --gas-ton would exceed
                                 this. Default 0.1.
  --mainnet                     opt in to mainnet (REAL FUNDS). Default: testnet.
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr *os.File) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, helpText)
		return 2
	}
	sub, rest := args[0], args[1:]
	if sub == "--help" || sub == "-h" {
		fmt.Fprint(stdout, helpText)
		return 0
	}

	ctx := context.Background()

	var err error
	switch sub {
	case "deploy":
		err = runDeploy(ctx, rest, stdout)
	case "notify":
		err = runNotify(ctx, rest, stdout)
	case "status":
		err = runStatus(ctx, rest, stdout)
	case "update-providers":
		err = runUpdateProviders(ctx, rest, stdout)
	default:
		fmt.Fprintf(stderr, "storage-v1-client: unknown subcommand %q\n\n", sub)
		fmt.Fprint(stdout, helpText)
		return 2
	}

	if err != nil {
		fmt.Fprintf(stderr, "storage-v1-client: %s: %v\n", sub, err)
		if _, ok := err.(*guardError); ok {
			return 2
		}
		return 1
	}
	return 0
}

// guardError marks an error that should exit 2 (a refused/guarded operation,
// as opposed to an unexpected failure) — mirrors
// scripts/ton-provider-experiment.mjs's process.exit(2) refusal points.
type guardError struct{ error }

func guardf(format string, a ...any) error {
	return &guardError{fmt.Errorf(format, a...)}
}

// newFlagSet builds a flag.FlagSet whose usage/error output is suppressed on
// the caller's behalf — every subcommand reports its own errors with full
// context via the returned error, so flag's default "flag provided but not
// defined" chatter would just be noise on top of that.
func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(discardWriter{})
	return fs
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
