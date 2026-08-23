package main

import "math/big"

// mbBytes / minSizeMBBytes / deployBufferNano port the amount-estimation
// constants and formula from scripts/ton-provider-experiment.mjs
// (storageCostNano, DEPLOY_BUFFER_NANO — see that script's header
// docs/provider-contract.md citation and its own comment: "0.3 TON buffer
// covers contract deployment gas regardless of bag size"). The task spec for
// this program names the same figure directly ("0.3 TON程度のbuffer").
//
// Unlike the JS reference (which computes this via Number/float64 and
// Math.ceil), this program does the whole computation in exact big.Int
// arithmetic — no floating point ever touches a money value here.
const mbBytes = 1_000_000

const minSizeMBBytes = 100_000 // 0.1 MB floor, same as the JS reference

var deployBufferNano = big.NewInt(300_000_000) // 0.3 TON

// storageCostNano computes ceil(effectiveBytes * ratePerMbDayNano * spanDays / 1_000_000)
// as an exact integer, where effectiveBytes = max(dataSizeBytes, minSizeMBBytes)
// — the same formula as scripts/ton-provider-experiment.mjs storageCostNano.
func storageCostNano(dataSizeBytes, ratePerMbDayNano, spanDays uint64) *big.Int {
	effBytes := dataSizeBytes
	if effBytes < minSizeMBBytes {
		effBytes = minSizeMBBytes
	}
	num := new(big.Int).SetUint64(effBytes)
	num.Mul(num, new(big.Int).SetUint64(ratePerMbDayNano))
	num.Mul(num, new(big.Int).SetUint64(spanDays))
	return ceilDivBigInt(num, big.NewInt(mbBytes))
}

// ceilDivBigInt returns ceil(num/den) for non-negative num and positive den.
func ceilDivBigInt(num, den *big.Int) *big.Int {
	q, r := new(big.Int).QuoRem(num, den, new(big.Int))
	if r.Sign() != 0 {
		q.Add(q, big.NewInt(1))
	}
	return q
}

// deployAmountNano is the suggested Tonkeeper transfer amount: storage cost
// (see storageCostNano) plus the fixed deploy-gas buffer.
func deployAmountNano(dataSizeBytes, ratePerMbDayNano, spanDays uint64) *big.Int {
	amount := storageCostNano(dataSizeBytes, ratePerMbDayNano, spanDays)
	amount.Add(amount, deployBufferNano)
	return amount
}
