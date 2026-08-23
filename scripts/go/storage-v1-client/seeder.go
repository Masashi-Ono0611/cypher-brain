package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// hostRe / apiRe mirror the remote-command safety allowlists in
// scripts/ton-provider-experiment.mjs (HOST_RE / API_RE): every value
// interpolated into a REMOTE shell command line must pass a narrow allowlist
// first, so a malicious/malformed env var can't break out of the intended
// curl invocation.
var (
	hostRe = regexp.MustCompile(`^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$`)
	apiRe  = regexp.MustCompile(`^[A-Za-z0-9.:-]+$`)
)

func assertSafe(value, what string, re *regexp.Regexp) (string, error) {
	if value == "" || !re.MatchString(value) || strings.HasPrefix(value, "-") {
		return "", fmt.Errorf("%s contains characters this program refuses to place in a remote command: %q", what, value)
	}
	return value, nil
}

// seederDetails is the subset of tonutils-storage's /api/v1/details response
// (xssnick/tonutils-storage api/api.go, BagDetailed) this program needs to
// build a StorageV1 deploy: BagSize (== StorageV1.DataSize), PieceSize
// (== StorageV1.PieceSize), and MerkleHash (== StorageV1.MerkleHash, the
// torrent's merkle root — a DIFFERENT value from the bag id/torrent hash;
// see main.go field notes).
type seederDetails struct {
	BagSizeBytes uint64
	PieceSize    uint32
	MerkleHash   []byte
}

// fetchSeederDetails mirrors scripts/ton-provider-experiment.mjs
// getBagSizeBytesFromSeeder (same SSH allowlisting, same env vars, same
// /api/v1/details endpoint on cypher-brain's own seeder), extended to also
// read piece_size and merkle_hash — both already exposed by that endpoint
// (api/api.go handleDetails: res.BagSize = t.Info.FileSize, res.PieceSize =
// t.Info.PieceSize, res.MerkleHash = hex.EncodeToString(t.Info.RootHash)).
// This is the honesty-gap-closing improvement over the JS reference script,
// which only needed (and only fetched) bag size for the C++ scheme.
//
// UNVERIFIED IN THIS SESSION — no seeder was reachable to actually run this
// against; see the completion report.
func fetchSeederDetails(ctx context.Context, bagIDHex string) (*seederDetails, error) {
	host, err := assertSafe(os.Getenv("CYPHER_BRAIN_TON_SSH_HOST"), "CYPHER_BRAIN_TON_SSH_HOST", hostRe)
	if err != nil {
		return nil, err
	}
	api := os.Getenv("CYPHER_BRAIN_TON_REMOTE_API")
	if api == "" {
		api = "127.0.0.1:9955"
	}
	api, err = assertSafe(api, "CYPHER_BRAIN_TON_REMOTE_API", apiRe)
	if err != nil {
		return nil, err
	}
	if !hex64Re.MatchString(bagIDHex) {
		return nil, fmt.Errorf("bag id must match ^[0-9a-f]{64}$, got %q", bagIDHex)
	}

	args := []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10"}
	if key := os.Getenv("CYPHER_BRAIN_TON_SSH_KEY"); key != "" {
		args = append(args, "-i", key)
	}
	remoteCmd := fmt.Sprintf("curl -sS --fail -m 30 'http://%s/api/v1/details?bag_id=%s'", api, bagIDHex)
	args = append(args, "--", host, remoteCmd)

	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "ssh", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if runErr := cmd.Run(); runErr != nil {
		return nil, fmt.Errorf("ssh failed: %w: %s", runErr, truncate(stderr.String(), 2000))
	}

	var parsed struct {
		BagSize    uint64 `json:"bag_size"`
		PieceSize  uint32 `json:"piece_size"`
		MerkleHash string `json:"merkle_hash"`
		Error      string `json:"error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		return nil, fmt.Errorf("seeder /api/v1/details returned non-JSON for bag %s: %s", bagIDHex, truncate(stdout.String(), 200))
	}
	if parsed.Error != "" {
		return nil, fmt.Errorf("seeder /api/v1/details failed for bag %s: %s", bagIDHex, parsed.Error)
	}
	if parsed.BagSize == 0 {
		return nil, fmt.Errorf(
			"seeder returned no positive bag_size for bag %s — is it actually seeded there? "+
				"Pass --size-bytes/--piece-size/--merkle-hash to override", bagIDHex)
	}
	if parsed.PieceSize == 0 {
		return nil, fmt.Errorf("seeder returned no positive piece_size for bag %s", bagIDHex)
	}
	merkleHash, err := parseHex32("seeder merkle_hash", parsed.MerkleHash)
	if err != nil {
		return nil, fmt.Errorf("seeder returned invalid merkle_hash for bag %s: %w", bagIDHex, err)
	}

	return &seederDetails{
		BagSizeBytes: parsed.BagSize,
		PieceSize:    parsed.PieceSize,
		MerkleHash:   merkleHash,
	}, nil
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n]
}
