package main

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"time"

	"github.com/xssnick/tonutils-go/adnl"
	"github.com/xssnick/tonutils-go/adnl/dht"
	"github.com/xssnick/tonutils-storage-provider/pkg/transport"
)

// newProviderTransportClient opens the same ephemeral-key + ADNL-gateway +
// DHT-client session both notify.go's notifyProvider and rates.go's
// checkProviderRates need to reach a provider daemon over ADNL/RLDP —
// factored out (2026-08-29, issue #651) so the two subcommands share one
// connection-setup path instead of drifting independently, exactly as
// notify.go's own header already documented this shape came from
// xssnick/tonutils-storage-provider's cmd/resolver/main.go /
// tonutils-go's example/resolve-adnl/main.go.
//
// The returned closer is notify.go's original `defer gw.Close()`, unchanged
// (error deliberately discarded — same as before this was factored out): a
// throwaway per-call ADNL gateway has nothing left to flush or report once
// the caller is done with it.
func newProviderTransportClient(ctx context.Context, configURL string, timeout time.Duration) (*transport.Client, func() error, error) {
	_, prv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, nil, fmt.Errorf("generate ephemeral ADNL key: %w", err)
	}

	gw := adnl.NewGateway(prv)
	if err := gw.StartClient(); err != nil {
		return nil, nil, fmt.Errorf("start ADNL client gateway: %w", err)
	}

	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	dhtClient, err := dht.NewClientFromConfigUrl(dctx, gw, configURL)
	if err != nil {
		_ = gw.Close()
		return nil, nil, fmt.Errorf("create DHT client from %s: %w", configURL, err)
	}

	return transport.NewClient(gw, dhtClient), gw.Close, nil
}
