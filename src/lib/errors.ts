// Stable, ngrok-style ("CB-E###") error codes for cypher-brain's own most-common
// failure messages (issue #212). ngrok's own docs (https://ngrok.com/docs/errors) are
// the model: a short stable code + a doc link next to the human-readable message, so a
// person mid-incident (or an AI agent wrapping the CLI/MCP tools) can look up cause +
// next action in one place instead of parsing prose.
//
// Design constraint (issue #212): additive only, NEVER touches an existing throw site's
// message text. Every entry below is matched AFTER the fact, against the already-
// formatted error text, at the two places every error funnels through before a human/
// agent sees it — cli.ts's top-level `main().catch` and mcp.ts's `structuredErr()`. That
// keeps every one of the existing `throw new Error(...)` call sites across src/lib/**
// (296, as of writing — this design's guarantee doesn't depend on that count staying
// accurate) completely untouched; only those two display boundaries changed.
//
// Coverage is deliberately partial (issue #212 asks for "10-15 representative patterns",
// not exhaustive). An error that matches nothing here is displayed exactly as before,
// with no code appended — that is the intended, safe default, not a bug. Add a new
// entry (+ a matching row in MANAGEMENT.md's "## Error codes" table) whenever a new
// failure pattern turns out to be common enough to deserve one; nothing else needs to
// change.
//
// Trade-off this design accepts: a `pattern` is matched
// against MUTABLE human-readable text, not a typed error/explicit metadata at the throw
// site — that's the whole point (it's what lets every throw site stay untouched), but it
// also means rewording the underlying message can silently stop a pattern from matching,
// with no compiler or test to catch it for a code whose scenario isn't exercised by
// scripts/selftest*.sh. Two things mitigate it. Each entry's `source` comment below
// points at the exact file the pattern's substring is copied from, so editing that
// message is the trigger to `grep -rn <old substring> src/lib/errors.ts` and update the
// pattern in the SAME change — treat `source` as a live reference, not a stale note.
// And since #295 that is no longer only a convention: `origin` (below) marks which
// entries we write the text for, and scripts/selftest-error-codes.mjs — part of
// `npm run verify` — fails when one of those patterns no longer matches anything in
// src/. It cannot prove a code still ATTACHES at runtime, but it does catch the case
// this warning is about: a reworded throw site leaving a pattern behind.

export interface ErrorCodeEntry {
  /** Stable, never-reused identifier — this repo's equivalent of ERR_NGROK_xxx. */
  readonly code: string;
  /** One-line human title, used only in MANAGEMENT.md's table — never printed at runtime. */
  readonly title: string;
  /** Matched against the fully-formatted error message (errMsg(e)); first match wins. */
  readonly pattern: RegExp;
  /**
   * Where this pattern's substring is copied from (file[:line], as of writing) — not
   * used at runtime; a live pointer for whoever edits that throw site next, so a
   * reworded message and this pattern change together instead of silently drifting apart.
   */
  readonly source: string;
  /**
   * Who writes the text this pattern matches — and therefore whether a test can check
   * it (#295). The header comment above notes that rewording a message can silently
   * stop a pattern matching, with nothing to catch it; the reason that check did not
   * exist is that two different kinds of entry were indistinguishable except in the
   * prose of `source`.
   *
   * - 'ours'     — every alternative is copied from a throw site in src/. If someone
   *                rewords one of those messages without touching this table, the code
   *                stops attaching. scripts/selftest-error-codes.mjs asserts all of
   *                them still match, which is the check that was missing.
   * - 'upstream' — the substring is a DEPENDENCY's own wording (arweave,
   *                @ardrive/turbo-sdk, node), which we never write and cannot assert
   *                against src/. Its risk is real but different: an upstream release
   *                can reword it, and no check of ours would see that either way. Not
   *                asserted — but now visibly unasserted rather than silently so.
   * - 'mixed'    — the pattern deliberately spans both. CB-E006 is the case that forced
   *                this third value: "exceeds CYPHER_BRAIN_MAX_SPEND" is ours,
   *                "insufficient balance/funds" is the SDKs'. Such an entry must ALSO
   *                list the alternatives we write in `assertLiterals`, and the selftest
   *                requires every one of those to be present. Merely requiring "one of
   *                the alternatives" would let the upstream half — which could start
   *                appearing under src/ for an unrelated reason — hold the check up
   *                while our half rotted away.
   */
  readonly origin: 'ours' | 'upstream' | 'mixed';
  /**
   * Required when origin is 'mixed': the alternatives of `pattern` that WE write, which
   * scripts/selftest-error-codes.mjs then requires to be present in src/. Not used at
   * runtime.
   */
  readonly assertLiterals?: readonly string[];
}

// The doc anchor every annotated message points readers at — a full GitHub URL rather
// than a bare relative filename (#727). MANAGEMENT.md is NOT part of the published npm
// package (package.json's `files` ships only `dist`; `npm pack --dry-run` confirms the
// tarball holds just LICENSE/README.md/dist/package.json), so an agent or human running
// the server via `npx`/a global install who followed a relative "MANAGEMENT.md" pointer
// found no such file anywhere near the installed package. Keep the "MANAGEMENT.md#error-
// codes" suffix in sync with the "## Error codes" heading in MANAGEMENT.md (GitHub
// renders that heading's anchor as exactly this slug).
export const ERROR_DOC_REF = 'https://github.com/Masashi-Ono0611/cypher-brain/blob/main/MANAGEMENT.md#error-codes';

// Order is not currently significant (no two patterns below can both match the same
// message), but new entries should stay specific enough to keep it that way — prefer a
// longer, more literal substring over a broad one that could shadow a future entry.
export const ERROR_CODES: readonly ErrorCodeEntry[] = [
  {
    code: 'CB-E001',
    title: 'integrity pin mismatch — fetched bytes do not match --sha256',
    pattern: /sha256 mismatch: fetched/,
    origin: 'ours',
    source: 'src/lib/pushpull.ts (pull, "sha256 mismatch: fetched …")',
  },
  {
    code: 'CB-E002',
    title: 'age decrypt failed (wrong identity, or corrupt/truncated ciphertext)',
    pattern: /age decrypt failed:/,
    origin: 'ours',
    source: 'src/lib/crypt.ts (decryptToChild, "age decrypt failed: …")',
  },
  {
    code: 'CB-E003',
    title: 'cannot unwrap a passphrase-protected identity (wrong passphrase?)',
    pattern: /\(wrong passphrase\?\)/,
    origin: 'ours',
    source: 'src/lib/crypt.ts (unwrapTextFile, "could not unwrap … (wrong passphrase?)")',
  },
  {
    code: 'CB-E004',
    title: 'storage object not yet retrievable (upload not yet propagated)',
    pattern: /not mined \/ not found \/ not yet seeded/,
    origin: 'ours',
    source: 'src/lib/backends/arweave.ts (get, RetryableError "… not mined / not found / not yet seeded")',
  },
  {
    code: 'CB-E005',
    title: 'recipient rejected by the CYPHER_BRAIN_PIN_RECIPIENTS allowlist',
    pattern: /is NOT in CYPHER_BRAIN_PIN_RECIPIENTS/,
    origin: 'ours',
    source: 'src/lib/snapshot.ts (snapshot, "… is NOT in CYPHER_BRAIN_PIN_RECIPIENTS")',
  },
  {
    code: 'CB-E006',
    title: 'spend cap exceeded, or wallet balance insufficient (paid backend)',
    pattern: /exceeds CYPHER_BRAIN_MAX_SPEND|insufficient (?:balance|funds)/i,
    origin: 'mixed',
    // The half WE write, named explicitly so the selftest checks it. "any one
    // alternative is present" would be too weak: the upstream wording could start
    // appearing under src/ for an unrelated reason and hold the check up while this
    // one rotted away.
    assertLiterals: ['exceeds CYPHER_BRAIN_MAX_SPEND'],
    source:
      'src/lib/backends/arweave.ts + src/lib/backends/turbo.ts ("… exceeds CYPHER_BRAIN_MAX_SPEND=…"); ' +
      '"insufficient balance/funds" also matches the arweave/turbo-sdk packages’ own thrown wording',
  },
  // #781: was `/spends real funds/` — too broad. That substring also appears in TWO
  // "the spend cap env var isn't set" refusals (src/lib/schedule.ts's ton-provider
  // schedule-install check, src/lib/backends/ton-provider.ts's push-time check) that
  // --yes cannot fix — the fix there is setting CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND, a
  // one-time operator/environment change, not a per-run consent flag. An agent (or
  // human) reading `code: CB-E007` off either of those got this entry's title ("…
  // needs explicit spend consent (--yes)") and retried with --yes, which does nothing
  // for a cap that was never configured. Anchored instead to "re-run push with --yes
  // or set CYPHER_BRAIN_YES=1 in the environment to confirm" — the tail wording ONLY
  // the two genuine --yes-fixable consent refusals share — so it no longer shadows
  // CB-E024 below. Deliberately does NOT include the "spends real funds — " prefix:
  // in pushpull.ts's source that prefix and this tail are two SEPARATE template-
  // literal string pieces (concatenated with `+` across a line break), so a pattern
  // spanning both would not appear as one contiguous substring in the .ts file text
  // that scripts/selftest-error-codes.mjs's literal check greps against, even though
  // the two evaluate to one string at runtime.
  {
    code: 'CB-E007',
    title: 'paid backend upload needs explicit spend consent (--yes)',
    pattern: /re-run push with --yes or set CYPHER_BRAIN_YES=1 in the environment to confirm/,
    origin: 'ours',
    source:
      'src/lib/pushpull.ts (push, "… spends real funds — re-run push with --yes or set CYPHER_BRAIN_YES=1 in the ' +
      'environment to confirm…" — shared verbatim by the arweave/turbo and ton-provider consent refusals)',
  },
  {
    code: 'CB-E008',
    title: 'refusing to push non-ciphertext to storage',
    pattern: /not age ciphertext \(header mismatch\)/,
    origin: 'ours',
    source: 'src/lib/pushpull.ts (push, "… is not age ciphertext (header mismatch) — …")',
  },
  {
    code: 'CB-E009',
    title: 'refusing to overwrite an existing output (no-clobber)',
    pattern: /already exists — refusing to overwrite/,
    origin: 'ours',
    source:
      'src/lib/pushpull.ts (push/pull) + src/lib/snapshot.ts (snapshot) + src/lib/backends/rclone.ts (put, #533), ' +
      '"… already exists — refusing to overwrite …"',
  },
  {
    code: 'CB-E010',
    title: 'locator rejected — outside the store, or the wrong shape (possible path traversal)',
    pattern: /locator is outside FILE_DIR|does not match the expected <sha256>\.age shape/,
    origin: 'ours',
    source:
      'src/lib/backends/file.ts (get, "locator is outside FILE_DIR" / "does not match the expected <sha256>.age shape")',
  },
  {
    code: 'CB-E011',
    title: 'Arweave JWK wallet missing or unreadable',
    pattern: /needs CYPHER_BRAIN_AR_WALLET|cannot read JWK wallet at/,
    origin: 'ours',
    source:
      'src/lib/backends/arweave.ts + src/lib/backends/turbo.ts ("… needs CYPHER_BRAIN_AR_WALLET …" / "cannot read JWK wallet at …"), ' +
      'and the same "cannot read JWK wallet at …" text from wallet.ts\'s addressFromWallet() (wallet address/wallet balance, #608) ' +
      'for any non-ENOENT read failure (corrupt/non-JSON file, permission error, …)',
  },
  // CB-E012's wording is generated once in sdkImportAdvice() (#344) with the package
  // name interpolated, so the pattern anchors on the generated invariant rather than
  // the two spelled-out package names. Only the 'absent' class carries this code — an
  // installed-but-broken SDK is a different condition (and message) on purpose.
  {
    code: 'CB-E012',
    title: 'optional storage SDK dependency not installed',
    pattern: /is not installed — run: npm install /,
    origin: 'ours',
    source: "src/lib/util.ts (sdkImportAdvice, kind: 'absent')",
  },
  {
    code: 'CB-E013',
    title: 'unknown --backend name',
    pattern: /unknown backend:/,
    origin: 'ours',
    source: 'src/lib/backends/index.ts (backendFor) + src/lib/estimate.ts (estimateCost), "unknown backend: …"',
  },
  {
    code: 'CB-E014',
    title: 'schedule automation not installed, or crontab write failed',
    pattern: /schedule not installed \(no |crontab write failed/,
    origin: 'ours',
    source: 'src/lib/schedule.ts ("schedule not installed (no …" / "crontab write failed: …")',
  },
  {
    code: 'CB-E015',
    title: 'identity file not found (cannot decrypt)',
    pattern: /cannot decrypt without the private key/,
    origin: 'ours',
    source:
      'src/lib/restore.ts (restoreImpl, and runFileChecks for an EXPLICIT --identity path on verify, #531), ' +
      '"no identity at … — cannot decrypt without the private key"',
  },
  {
    code: 'CB-E016',
    title: 'minisign authenticity signature failed to verify — refusing to decrypt (#214)',
    pattern: /signature (?:does not verify|verification failed)/,
    origin: 'ours',
    source:
      'src/lib/restore.ts (restoreImpl) + src/lib/minisign.ts (verifyDetached), "… signature does not verify …" / "… signature verification failed …"',
  },
  {
    code: 'CB-E017',
    title: 'schedule config is corrupt — invalid JSON, or missing a required field (#494)',
    pattern: /schedule config is corrupt \(/,
    origin: 'ours',
    source:
      'src/lib/schedule.ts (readConfig, "schedule config is corrupt (… is not valid JSON: …" / "… is missing required field …")',
  },
  {
    code: 'CB-E018',
    title: 'no object at the given locator/remote path (nothing was ever pushed there)',
    pattern: /no object at /,
    origin: 'ours',
    source:
      'src/lib/backends/file.ts (get, "file backend: no object at …") + src/lib/backends/rclone.ts (runRclone, ' +
      '"rclone backend: no object at …", #539 — translated from rclone\'s own raw "directory not found" retry-loop text)',
  },
  {
    code: 'CB-E019',
    title: 'wallet JWK file not found at the given/default path',
    pattern: /no wallet at /,
    origin: 'ours',
    source: 'src/lib/wallet.ts (walletAddress, "…: no wallet at … — run \'cypher-brain wallet create\' first")',
  },
  {
    code: 'CB-E020',
    title: 'recipient (age1... pubkey or file of pubkeys) not found',
    pattern: /no recipient at /,
    origin: 'ours',
    source:
      'src/lib/snapshot.ts (snapshot, "no recipient at … — run \\"cypher-brain keygen\\" first, or pass an age1... pubkey") + ' +
      'src/lib/recoverykit.ts (same "no recipient at …" condition for the recovery kit)',
  },
  {
    code: 'CB-E021',
    title: 'restore --out-dir already exists and is not a directory',
    pattern: /exists and is not a directory/,
    origin: 'ours',
    source: 'src/lib/restore.ts (restoreImpl, "--out-dir … exists and is not a directory")',
  },
  {
    code: 'CB-E022',
    title: '--sign-identity path does not exist (refusing to write an unsigned snapshot)',
    pattern: /does not exist — refusing to write an unsigned snapshot/,
    origin: 'ours',
    source:
      'src/lib/snapshot.ts (snapshot, "--sign-identity … does not exist — refusing to write an unsigned snapshot", #601)',
  },
  // Prefix-only, not "--sign-recipient .*does not exist": the interpolated path sits
  // between the two invariant halves of this message, and scripts/selftest-error-
  // codes.mjs's literal-extraction only understands plain substrings — a wildcard
  // spanning the path makes it fail closed with "cannot extract literals" (verified),
  // not silently skip. The trade-off (same one CB-E019's "no wallet at " prefix and
  // CB-E020's "no recipient at " prefix already accept) is a false-positive risk if some
  // future unrelated throw site's message also happened to contain this literal; today it
  // does not (grep confirms only restore.ts's two "--sign-recipient … does not exist"
  // throw sites contain it).
  {
    code: 'CB-E023',
    title: '--sign-recipient path does not exist',
    pattern: /--sign-recipient /,
    origin: 'ours',
    source: 'src/lib/restore.ts (restoreImpl + runFileChecks, "--sign-recipient … does not exist", #601)',
  },
  // #781: split out of CB-E007 above — "ton-provider needs a spend cap configured" is a
  // DIFFERENT condition from "confirm this paid upload with --yes", even though both
  // throw sites' prose happens to contain the substring "spends real funds" (CB-E007's
  // OLD, too-broad pattern). The fix for THIS one is setting
  // CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND in the environment — a one-time operator/config
  // change --yes cannot substitute for, unlike CB-E007's genuinely per-run consent gate.
  // Two independent throw sites, two different exact wordings (neither a substring of
  // the other, and neither prefixed by the env var name close enough to the OTHER
  // half's distinguishing text to share it — see each alternative's own comment).
  //
  // First alternative: "(nanoTON) must be set in the" rather than continuing through
  // "environment before install" — in schedule.ts's source, "in the " and "environment
  // before install" are two separate template-literal pieces joined with `+` across a
  // line break, so the longer phrase never appears as ONE contiguous substring in the
  // .ts file text scripts/selftest-error-codes.mjs greps against, even though they
  // concatenate to one string at runtime. Dropped the "CYPHER_BRAIN_TON_PROVIDER_MAX_
  // SPEND " prefix (present right before it in the real message) only to fit this line
  // under biome's 120-column limit — "(nanoTON) must be set in the" alone is already
  // unique to this one throw site (grep confirms).
  //
  // Second alternative: "must be set to a positive nanoTON amount" — no line-break
  // split in backends/ton-provider.ts's source, but shortened the same way and for the
  // same reason (also grep-confirmed unique).
  {
    code: 'CB-E024',
    title: 'ton-provider spend cap not configured (CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND) — --yes will not fix this',
    pattern: /\(nanoTON\) must be set in the|must be set to a positive nanoTON amount/,
    origin: 'ours',
    source:
      'src/lib/schedule.ts (installSchedule, "ton-provider is a paid store: CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND ' +
      '(nanoTON) must be set in the environment before install — …") + ' +
      'src/lib/backends/ton-provider.ts (put, "ton-provider backend: CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND must be ' +
      'set to a positive nanoTON amount …")',
  },
];

/** The first registry entry whose pattern matches `message`, if any. */
export function matchErrorCode(message: string): ErrorCodeEntry | undefined {
  return ERROR_CODES.find((e) => e.pattern.test(message));
}

// #779: a PARSER-LEVEL refusal — a mistyped sub-verb (`wallet adress`), an
// enum-valued flag given a value it does not accept (`--level remtoe`, `--chain
// tona`, `--backend fille`), an unrecognized top-level command or flag, or a flag a
// command declares it does not read (FLAG_IRRELEVANT in src/cli.ts) — is "the
// command line itself was malformed", the same class getopt/most POSIX CLIs exit 2
// for, as distinct from a failure that happened while doing the work (a decrypt
// failure, a network error, a spend cap exceeded) which exits 1. cli.ts's two
// hand-rolled replies for "no command"/"unknown command" already followed that
// convention directly (their own `process.exitCode = 2`), but every OTHER
// parser-level refusal threw a plain Error and fell into main().catch()'s single
// generic handler below, which unconditionally set exit 1 — an agent scripting
// against this CLI could not tell "cypher-brain restore" (forgot --in, --out-dir:
// malformed invocation) from "cypher-brain restore --in x --out-dir y" (right
// shape, decrypt failed: a real failure) by exit code alone. Throwing UsageError
// from a parser-level refusal lets the generic handler answer both classes
// correctly, and — since the two hand-rolled arms now throw it too instead of
// setting process.exitCode directly and returning — routes them through the SAME
// path, which is what makes `cypher-brain bogus --json` print a JSON error object
// (previously: nothing, since that reply never reached the --json branch below).
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The process exit code an error should produce: 2 for a UsageError, 1 otherwise. */
export function exitCodeFor(e: unknown): 1 | 2 {
  return e instanceof UsageError ? 2 : 1;
}

// Append "[CB-E0xx] see MANAGEMENT.md#error-codes" to an already-formatted error message
// when (and only when) it matches a known pattern; an unmatched message is returned
// byte-for-byte unchanged (issue #212's "additive only" constraint). Call this ONLY at a
// display boundary (cli.ts's top-level catch, mcp.ts's structuredErr) — never at an
// individual throw site, so every existing message body stays exactly as it was.
export function annotateErrorMessage(message: string): string {
  const entry = matchErrorCode(message);
  return entry ? `${message} [${entry.code}] see ${ERROR_DOC_REF}` : message;
}
