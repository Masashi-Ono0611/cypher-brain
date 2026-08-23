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
//     always includes exactly the one --provider given.
//   - Funding + deploying on-chain does NOT by itself make a provider daemon
//     aware of the contract (internal/service/startup_wallet_scan.go and
//     stopped_reconciler.go only re-check contracts a provider ALREADY
//     accepted — they are not a new-contract discovery path, and they are
//     unexported `internal/` code this program cannot import anyway). The
//     only new-contract discovery path is the ADNL push `notify` sends.
//   - A provider's identity is a single 32-byte ed25519 public key, used
//     BOTH as its on-chain ProviderV1.Address (workchain 0, address.Data() ==
//     the pubkey — see tonutils-storage cli/main.go:
//     address.NewAddress(0, 0, prv)) AND as the DHT/ADNL lookup key for
//     `notify`. --provider therefore takes a raw workchain-0 TON address and
//     this program extracts its Data() bytes for the ADNL side itself —
//     there is only one value to supply, not two.
//   - mytonprovider.org's registry `price` field is NOT the raw
//     rate_per_mb_day the contract wants — it is
//     rate_per_mb_day * 1024 * 200 * 30 (a 200 GB/30-day cost estimate).
//     Divide by that same constant to recover --rate-nano-per-mb-day. This
//     program does not call the registry itself (kept out of scope — see
//     --help); the operator resolves the rate externally and passes it in.
//
// THIS PROGRAM NEVER TOUCHES A PRIVATE KEY. `deploy` only prints a Tonkeeper
// deeplink for a human to review and sign. `notify` and `status` are
// read-only network calls (ADNL query / HTTP GET respectively) that move no
// funds.
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
It never touches a private key: 'deploy' prints a Tonkeeper transfer deeplink
for a human to review and sign; 'notify' and 'status' are read-only network
calls that move no funds.

Usage:
  storage-v1-client deploy --bag-id <64hex> --provider <raw-addr> \
      --rate-nano-per-mb-day <int> --span-days <int> --owner <raw-addr> \
      [--size-bytes <n> --piece-size <n> --merkle-hash <64hex>] \
      [--mainnet] [--max-spend-ton 0.5]
  storage-v1-client notify --provider <raw-addr> --contract <raw-addr> \
      [--mainnet] [--byte-to-proof <uint64>] [--timeout <seconds>]
  storage-v1-client status --contract <raw-addr> [--mainnet]
  storage-v1-client --help

deploy: derives the StorageV1 contract address, builds its StateInit + the
modify_providers deploy body (with --provider already included — see the
"field notes" in main.go), computes a suggested funding amount, and prints a
Tonkeeper deeplink. Refuses (exit 2) if the computed amount exceeds
--max-spend-ton.

  --bag-id <64hex>          required. The bag's TON Storage torrent hash
                             (== StorageV1.TorrentHash). This is the same
                             64-hex value as a cypher-brain "ton:v1:<hex>"
                             locator's suffix.
  --provider <raw-addr>     required. Raw workchain-0 TON address
                             ("0:<64hex>") of the target provider — this is
                             also the provider's 32-byte ADNL public key
                             (see main.go field notes); workchain -1 is
                             refused.
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
  --max-spend-ton <float>   refuse (exit 2) if the suggested amount would
                             exceed this. Default 0.5. Compared as nanoTON
                             (big.Int), never as a float.

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

  --provider <raw-addr>     required. Same address used for 'deploy'
                             --provider — its Data() bytes are used as the
                             ADNL lookup key.
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
informational, always exits 0 — mirrors scripts/ton-provider-experiment.mjs's
'status' subcommand. Does NOT decode whether a provider accepted the
contract, only whether it exists on-chain and its balance.

  --contract <raw-addr>     required.
  --mainnet                 opt in to mainnet. Default: testnet.
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
