package main

import (
	"encoding/base64"
	"math/big"
	"strings"
	"testing"

	"github.com/xssnick/tonutils-go/address"
)

func TestBuildDeployDeeplink(t *testing.T) {
	addr := address.NewAddress(0, 0, make([]byte, 32))
	body := []byte("body-bytes")
	stateInit := []byte("state-init-bytes")
	amount := big.NewInt(303_500_000)

	link := buildDeployDeeplink(addr, body, stateInit, amount, true)

	if !strings.HasPrefix(link, "ton://transfer/") {
		t.Fatalf("deeplink does not start with ton://transfer/: %s", link)
	}
	if !strings.Contains(link, "?bin=") || !strings.Contains(link, "&init=") || !strings.Contains(link, "&amount=303500000") {
		t.Fatalf("deeplink missing expected query params: %s", link)
	}

	// Extract and round-trip the bin/init params through the SAME encoding
	// the upstream reference CLI uses (padded base64.URLEncoding) — pins
	// this program to that exact, proven-working format rather than the
	// stripped-padding base64url scripts/ton-provider-experiment.mjs uses
	// for the unrelated C++ scheme.
	binB64 := extractQueryParam(t, link, "bin")
	gotBody, err := base64.URLEncoding.DecodeString(binB64)
	if err != nil {
		t.Fatalf("bin param is not padded base64.URLEncoding: %v", err)
	}
	if string(gotBody) != string(body) {
		t.Fatalf("round-tripped body = %q, want %q", gotBody, body)
	}

	initB64 := extractQueryParam(t, link, "init")
	gotInit, err := base64.URLEncoding.DecodeString(initB64)
	if err != nil {
		t.Fatalf("init param is not padded base64.URLEncoding: %v", err)
	}
	if string(gotInit) != string(stateInit) {
		t.Fatalf("round-tripped stateInit = %q, want %q", gotInit, stateInit)
	}
}

func TestBuildDeployDeeplinkTestnetVsMainnetAddressString(t *testing.T) {
	addr := address.NewAddress(0, 0, make([]byte, 32))
	body := []byte("b")
	stateInit := []byte("s")
	amount := big.NewInt(1)

	testnetLink := buildDeployDeeplink(addr, body, stateInit, amount, true)
	mainnetLink := buildDeployDeeplink(addr, body, stateInit, amount, false)

	testnetAddr := extractAddrFromDeeplink(t, testnetLink)
	mainnetAddr := extractAddrFromDeeplink(t, mainnetLink)

	if testnetAddr == mainnetAddr {
		t.Fatalf("testnet and mainnet address strings must differ (testnet flag byte), got the same: %s", testnetAddr)
	}
}

func extractQueryParam(t *testing.T, link, key string) string {
	t.Helper()
	marker := "&" + key + "="
	if strings.Contains(link, "?"+key+"=") {
		marker = "?" + key + "="
	}
	i := strings.Index(link, marker)
	if i < 0 {
		t.Fatalf("query param %q not found in %s", key, link)
	}
	rest := link[i+len(marker):]
	if j := strings.IndexByte(rest, '&'); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

func extractAddrFromDeeplink(t *testing.T, link string) string {
	t.Helper()
	const prefix = "ton://transfer/"
	if !strings.HasPrefix(link, prefix) {
		t.Fatalf("deeplink missing prefix: %s", link)
	}
	rest := link[len(prefix):]
	if i := strings.IndexByte(rest, '?'); i >= 0 {
		rest = rest[:i]
	}
	return rest
}
