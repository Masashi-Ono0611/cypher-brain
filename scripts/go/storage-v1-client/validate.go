package main

import (
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/xssnick/tonutils-go/address"
)

var hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// parseHex32 requires exactly 64 lowercase hex chars (256 bits) — same shape
// as scripts/ton-provider-experiment.mjs's HEX64_RE / LOCATOR_RE bag-id
// suffix, reused here for --bag-id and --merkle-hash.
func parseHex32(name, v string) ([]byte, error) {
	if !hex64Re.MatchString(v) {
		return nil, fmt.Errorf("%s must match ^[0-9a-f]{64}$, got %q", name, v)
	}
	b, err := hex.DecodeString(v)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return b, nil
}

// parseRawAddr parses a raw TON address ("wc:hex64") and restricts the
// workchain to an explicit allowlist. Ported rationale from
// scripts/ton-provider-experiment.mjs RAW_ADDR_RE: "Workchains in practice
// are 0 (base) and -1 (masterchain) — reject anything else instead of
// validating mere syntax."
func parseRawAddr(name, v string, allowedWorkchains ...int32) (*address.Address, error) {
	addr, err := address.ParseRawAddr(v)
	if err != nil {
		return nil, fmt.Errorf(`%s is not a raw TON address (want "wc:hex64"): %w`, name, err)
	}
	for _, wc := range allowedWorkchains {
		if addr.Workchain() == wc {
			return addr, nil
		}
	}
	return nil, fmt.Errorf("%s workchain %d is not one of %v", name, addr.Workchain(), allowedWorkchains)
}

// parseUint64Flag parses a non-negative base-10 integer flag value strictly
// (no signs, hex, or floats) — mirrors the ^[0-9]+$ discipline
// scripts/ton-provider-experiment.mjs applies to --size-bytes etc.
func parseUint64Flag(name, v string) (uint64, error) {
	if v == "" || strings.ContainsAny(v, "+-. \t") {
		return 0, fmt.Errorf("%s must be a non-negative base-10 integer, got %q", name, v)
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a non-negative base-10 integer, got %q: %w", name, v, err)
	}
	return n, nil
}

// parsePositiveUint64Flag is parseUint64Flag plus a > 0 check, for fields
// where zero is never meaningful (rate, span, size, piece size).
func parsePositiveUint64Flag(name, v string) (uint64, error) {
	n, err := parseUint64Flag(name, v)
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, fmt.Errorf("%s must be positive, got 0", name)
	}
	return n, nil
}
