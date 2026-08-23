package main

import (
	"encoding/base64"
	"fmt"
	"math/big"

	"github.com/xssnick/tonutils-go/address"
)

// buildDeployDeeplink reproduces, byte-for-byte, the deeplink shape the
// upstream reference CLI prints for its "rent-storage" command
// (xssnick/tonutils-storage cli/main.go:1665):
//
//	ton://transfer/<addr>?bin=<base64(body)>&init=<base64(stateInit)>&amount=<nanoTON>
//
// using padded base64.StdEncoding.URLEncoding (base64.URLEncoding — WITH
// "=" padding), not the stripped-padding base64url some other TON tooling
// (including scripts/ton-provider-experiment.mjs's toBase64Url) uses. This
// program intentionally matches the proven, real-world upstream CLI's own
// encoding rather than inventing its own convention for a different
// contract scheme.
func buildDeployDeeplink(contractAddr *address.Address, bodyBOC, stateInitBOC []byte, amountNano *big.Int, testnet bool) string {
	addr := contractAddr.Copy().Bounce(true).Testnet(testnet)
	return fmt.Sprintf(
		"ton://transfer/%s?bin=%s&init=%s&amount=%s",
		addr.String(),
		base64.URLEncoding.EncodeToString(bodyBOC),
		base64.URLEncoding.EncodeToString(stateInitBOC),
		amountNano.String(),
	)
}
