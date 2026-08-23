package main

import (
	"math/big"
	"testing"
)

func TestStorageCostNano(t *testing.T) {
	cases := []struct {
		name          string
		dataSizeBytes uint64
		rate          uint64
		spanDays      uint64
		want          *big.Int
	}{
		{
			name:          "exact division, at the 0.1MB floor",
			dataSizeBytes: 1, // far below the 100_000-byte floor
			rate:          1000,
			spanDays:      1,
			// effBytes=100_000; 100_000*1000*1 / 1_000_000 = 100 exactly
			want: big.NewInt(100),
		},
		{
			name:          "exact division, above the floor",
			dataSizeBytes: 500_000_000,
			rate:          1000,
			spanDays:      7,
			// 500_000_000*1000*7 / 1_000_000 = 3_500_000 exactly
			want: big.NewInt(3_500_000),
		},
		{
			name:          "needs ceiling",
			dataSizeBytes: 100_001, // effBytes stays 100_001 (already above floor)
			rate:          3,
			spanDays:      1,
			// 100_001*3*1 = 300_003 ; /1_000_000 = 0.300003 -> ceil = 1
			want: big.NewInt(1),
		},
		{
			name:          "zero size still floors to 0.1MB",
			dataSizeBytes: 0,
			rate:          10_000,
			spanDays:      1,
			// 100_000*10_000*1/1_000_000 = 1_000
			want: big.NewInt(1_000),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := storageCostNano(tc.dataSizeBytes, tc.rate, tc.spanDays)
			if got.Cmp(tc.want) != 0 {
				t.Fatalf("storageCostNano(%d,%d,%d) = %s, want %s", tc.dataSizeBytes, tc.rate, tc.spanDays, got, tc.want)
			}
		})
	}
}

func TestCeilDivBigInt(t *testing.T) {
	cases := []struct {
		num, den, want int64
	}{
		{10, 5, 2},
		{11, 5, 3},
		{1, 5, 1},
		{0, 5, 0},
		{9, 3, 3},
	}
	for _, tc := range cases {
		got := ceilDivBigInt(big.NewInt(tc.num), big.NewInt(tc.den))
		if got.Cmp(big.NewInt(tc.want)) != 0 {
			t.Fatalf("ceilDivBigInt(%d,%d) = %s, want %d", tc.num, tc.den, got, tc.want)
		}
	}
}

func TestDeployAmountNano(t *testing.T) {
	cost := storageCostNano(500_000_000, 1000, 7) // 3_500_000
	amount := deployAmountNano(500_000_000, 1000, 7)
	want := new(big.Int).Add(cost, deployBufferNano)
	if amount.Cmp(want) != 0 {
		t.Fatalf("deployAmountNano = %s, want %s (cost %s + buffer %s)", amount, want, cost, deployBufferNano)
	}
	// Sanity: buffer alone is 0.3 TON = 300_000_000 nanoTON, matching the
	// ported constant from ton-provider-experiment.mjs.
	if deployBufferNano.Cmp(big.NewInt(300_000_000)) != 0 {
		t.Fatalf("deployBufferNano = %s, want 300000000", deployBufferNano)
	}
}
