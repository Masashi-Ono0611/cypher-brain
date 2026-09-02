package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/xssnick/tonutils-go/address"
)

const (
	tonapiMainnetBase = "https://tonapi.io"
	tonapiTestnetBase = "https://testnet.tonapi.io"
)

// tonapiBaseOverride is a TEST-ONLY hook (set by deploy_test.go et al. to a local
// httptest.Server URL so a network-touching run* function can be exercised against a
// real HTTP round trip without ever reaching the actual internet) — always empty in
// production, where tonapiBase() falls through to the real mainnet/testnet hosts.
var tonapiBaseOverride string

func tonapiBase(testnet bool) string {
	if tonapiBaseOverride != "" {
		return tonapiBaseOverride
	}
	if testnet {
		return tonapiTestnetBase
	}
	return tonapiMainnetBase
}

type accountState struct {
	Status  string `json:"status"`
	Balance uint64 `json:"balance"`
	// Data is the account's raw state data cell, hex-encoded — returned by the
	// /v2/blockchain/accounts/ endpoint only (the /v2/accounts/ fallback below
	// has no such field, which is fine: that fallback only ever answers for an
	// account that has never been used, so there is no dict to read anyway).
	// Read by `providers` (providers.go) and by nothing else; every other
	// caller of fetchAccountState ignores it.
	Data string `json:"data"`
}

// stateVerdict ports scripts/ton-provider-experiment.mjs's stateVerdict — the
// same tonapi account-state vocabulary applies to any TON contract address,
// StorageV1 included (tonapi's `status` field distinguishes: nonexist — no
// funds present; uninit — funded but not yet run; active — deployed and
// running; frozen — was deployed, suspended).
func stateVerdict(status string) string {
	switch status {
	case "nonexist":
		return "NOT deployed — no funds present at this address"
	case "uninit":
		return "NOT deployed — funded but contract code has not run yet (normal right after a deploy lands, before it's processed)"
	case "active":
		return "deployed — contract code is running"
	case "frozen":
		return "frozen — was deployed, now suspended (e.g. out of balance); funds may still be recoverable"
	default:
		return fmt.Sprintf("<unrecognized tonapi status %q>", status)
	}
}

// fetchAccountStateAt performs one plain read-only HTTP GET against the
// given tonapi URL — deliberately NOT a full liteclient/ton.APIClientWrapped
// integration (that would need a global config + live lite-server
// connections just to answer "does this address exist on-chain yet"; tonapi
// answers the same question with a single HTTP GET, exactly as
// scripts/ton-provider-experiment.mjs already does for the C++ scheme). It
// also returns the raw HTTP status code (0 if the request never got a
// response) so fetchAccountState below can react to a specific code (404)
// without parsing error strings.
func fetchAccountStateAt(ctx context.Context, url string) (*accountState, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return nil, resp.StatusCode, fmt.Errorf("GET %s: reading response body: %w", url, readErr)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("GET %s -> HTTP %d: %s", url, resp.StatusCode, truncate(string(body), 200))
	}
	var acc accountState
	if err := json.Unmarshal(body, &acc); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("GET %s: non-JSON response: %s", url, truncate(string(body), 200))
	}
	return &acc, resp.StatusCode, nil
}

// fetchAccountState looks up addr's on-chain account state via tonapi's
// blockchain/accounts endpoint, falling back to the plain accounts endpoint
// on a 404 (see #716 below) — used by status/deploy/notify/update-providers/
// withdraw alike, so the fallback fixes all five call sites at once.
func fetchAccountState(ctx context.Context, addr *address.Address, testnet bool) (*accountState, error) {
	primaryURL := fmt.Sprintf("%s/v2/blockchain/accounts/%s", tonapiBase(testnet), addr.StringRaw())
	acc, status, err := fetchAccountStateAt(ctx, primaryURL)
	if err == nil {
		return acc, nil
	}
	if status != http.StatusNotFound {
		return nil, err
	}
	// #716: tonapi answers a genuinely-never-used address on the
	// blockchain/accounts endpoint with HTTP 404 {"error":"entity not
	// found"} — NOT an ordinary 200 status=nonexist response the way this
	// codebase had assumed (confirmed with curl against both mainnet and
	// testnet tonapi.io, for multiple independently-generated fresh
	// addresses; see the issue for the exact repro). The plain (non
	// "blockchain/") /v2/accounts/ endpoint answers the SAME address with an
	// ordinary 200 {"status":"nonexist",...} every time, so fall back to it
	// on a 404 instead of hard-failing every caller on what is actually the
	// completely normal "this address has never received a single nanoTON"
	// case (the standard state of a brand-new bag/owner pair's very first
	// deploy). A non-404 failure from the primary endpoint (timeout, 5xx,
	// malformed body) is NOT retried here — only a confirmed 404 is treated
	// as potentially just "not yet known to the blockchain-indexed view".
	fallbackURL := fmt.Sprintf("%s/v2/accounts/%s", tonapiBase(testnet), addr.StringRaw())
	fallbackAcc, _, fallbackErr := fetchAccountStateAt(ctx, fallbackURL)
	if fallbackErr != nil {
		return nil, fmt.Errorf("%w (fallback to %s also failed: %s)", err, fallbackURL, fallbackErr)
	}
	return fallbackAcc, nil
}

// statusParams / parseStatusFlags is the pure (network-free) argument
// parsing half of `status` — separated out so it is unit-testable without
// touching the network.
type statusParams struct {
	contract *address.Address
	testnet  bool
}

func parseStatusFlags(args []string) (*statusParams, error) {
	fs := newFlagSet("status")
	contractFlag := fs.String("contract", "", "deployed StorageV1 contract address (raw, required)")
	mainnet := fs.Bool("mainnet", false, "opt in to mainnet")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected extra arguments: %v", fs.Args())
	}
	if *contractFlag == "" {
		return nil, fmt.Errorf("status requires --contract <raw-addr>")
	}
	contract, err := parseRawAddr("--contract", *contractFlag, 0, -1)
	if err != nil {
		return nil, err
	}
	return &statusParams{contract: contract, testnet: !*mainnet}, nil
}

func runStatus(ctx context.Context, args []string, stdout io.Writer) error {
	p, err := parseStatusFlags(args)
	if errIsHelp(err) {
		fmt.Fprint(stdout, subHelpText("status"))
		return nil
	}
	if err != nil {
		return err
	}

	network := "mainnet"
	if p.testnet {
		network = "testnet"
	}
	fmt.Fprintf(stdout, "== status: %s (%s) ==\n", p.contract.StringRaw(), network)

	// Codex review finding (Warning): a genuine fetch failure (timeout, HTTP
	// error, malformed response) must be distinguishable from a successful
	// check by exit code, not just by the "[BLOCKED]" text — an automated
	// caller that only looks at the exit code must not be able to mistake
	// "could not determine the on-chain state" for "checked, and it looks
	// fine" (both would otherwise exit 0). The on-chain STATE ITSELF is still
	// never judged pass/fail here (see stateVerdict) — only the ability to
	// observe it at all is what gates the exit code.
	acc, err := fetchAccountState(ctx, p.contract, p.testnet)
	if err != nil {
		fmt.Fprintf(stdout, "  [BLOCKED] could not fetch account state from tonapi: %v\n", err)
		return fmt.Errorf("could not fetch account state: %w", err)
	}
	fmt.Fprintf(stdout, "  status:   %s\n", acc.Status)
	fmt.Fprintf(stdout, "  verdict:  %s\n", stateVerdict(acc.Status))
	fmt.Fprintf(stdout, "  balance:  %.6f TON (%d nanoTON)\n", float64(acc.Balance)/1e9, acc.Balance)
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "This does NOT decode whether a provider is actually storing this bag —")
	fmt.Fprintln(stdout, "that requires 'notify' + the provider's own response, or asking mytonstorage.org.")
	return nil
}

// errIsHelp reports whether err is flag.ErrHelp — -h/--help on a subcommand's
// own FlagSet exits the process successfully rather than as a usage error.
func errIsHelp(err error) bool {
	return err == flag.ErrHelp
}
