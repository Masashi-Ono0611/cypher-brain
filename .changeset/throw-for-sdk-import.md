---
'cypher-brain': patch
---

Deduplicated `sdkImportAdvice()`'s classify-and-throw pattern (#500). The same 3-branch
block — classify a lazy `import(pkg)` failure into absent/broken/other, then throw
`SdkMissingError`/`Error`/rethrow accordingly — was byte-for-byte duplicated 5 times
across `wallet.ts` (x3, for `arweave`/`@ton/crypto`/`@ton/ton`), `arweave.ts`, and
`ton-provider.ts`. All 5 sites now call a new `throwForSdkImport(e, pkg, ctx)` helper in
`util.ts`. Pure refactor — same error type and message thrown at every site, no behavior
change. The two legitimately-divergent 2-branch sites (`turbo.ts`, `ton-dns.ts`) and the
non-throwing sites (`otel.ts`, `estimate.ts`) are untouched.
