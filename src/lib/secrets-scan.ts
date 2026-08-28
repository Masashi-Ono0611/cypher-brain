// secrets-scan — gitleaks integration for `snapshot --scan-secrets warn|deny|off` (#215).
//
// It began as opt-in and stopped being so in #301: with no way to unsay a push to a
// write-once backend, the one preventive measure could not stay switched off by default.
// It now defaults to `warn` wherever a --dir/--profile source and a resolvable gitleaks
// both exist, and `off` is the way to say no out loud.
//
// Threat model this closes: the primary storage backends (Arweave/Turbo) are WRITE-ONCE,
// UN-DELETABLE. Today nothing inspects the CONTENTS of a --dir/--profile source before it
// is archived and encrypted, so an accidentally-included API key/token/password would be
// permanently committed to that backend — encryption alone does not help if the age
// identity is later lost or broken (see #205's post-quantum motivation for the same
// concern from the other direction). Rather than reinvent secret detection, this fully
// delegates to gitleaks (github.com/gitleaks/gitleaks) — an established scanner whose
// default ruleset and `.gitleaks.toml` customization/allowlisting the operator can already
// drop into a scanned source directory, exactly as they would for a git repo.
//
// Privacy of the scan's OWN output: gitleaks' `--redact` blanks the matched secret text in
// its JSON report, but this module goes further and never even reads that far — only
// `RuleID` is extracted back out, so no file path, line number, or match text from
// gitleaks' report ever reaches the manifest or console (matches the issue's "rule ID・
// 件数のみ" scope exactly).
import { readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITLEAKS_BIN } from './config.js';
import { run } from './proc.js';
import { setActiveScanReportDir } from './signal-guard.js';
import { errMsg } from './util.js';
import { warn } from './warn.js';

// `off` exists because the scan is no longer opt-in (#301): when gitleaks is resolvable
// and no mode was named, snapshot() defaults to `warn`. A user who does not want that
// needs a way to say so that is not "uninstall gitleaks", and it has to be a MODE rather
// than a separate boolean flag so every surface that already carries the mode — the CLI
// flag, the baked-in nightly runner, the MCP enum — carries the opt-out too.
export type ScanSecretsMode = 'warn' | 'deny' | 'off';

// The two modes that actually scan. `off` is a decision, not a way of scanning, so the
// reporting path below cannot be handed one.
export type ActiveScanMode = Exclude<ScanSecretsMode, 'off'>;

// The accepted values, as data — every surface that offers the scan (the CLI's
// --scan-secrets, `schedule install`'s baked-in runner, and the MCP snapshot_now
// schema's `enum`) reads THIS, so an advertised enum can never drift from what
// snapshot() actually accepts (#307).
export const SCAN_SECRETS_MODES: readonly ScanSecretsMode[] = ['warn', 'deny', 'off'];

export const isScanSecretsMode = (v: unknown): v is ScanSecretsMode =>
  typeof v === 'string' && (SCAN_SECRETS_MODES as readonly string[]).includes(v);

export interface SecretFinding {
  rule_id: string;
  count: number;
}

interface GitleaksRawFinding {
  RuleID?: string;
}

// Shape check for a single report entry — permissive on WHICH fields exist (gitleaks'
// finding objects carry many we never read) but strict that, if present, RuleID is a
// string. Mirrors the field-by-field validation every other JSON.parse site in this
// codebase already does (audit.ts, receipt.ts, idempotency.ts, plan.ts, doctor.ts,
// buildinfo.ts) rather than trusting a blind `as GitleaksRawFinding[]` cast (#495).
const isGitleaksFinding = (v: unknown): v is GitleaksRawFinding => {
  if (v === null || typeof v !== 'object') return false;
  const ruleId = (v as { RuleID?: unknown }).RuleID;
  return ruleId === undefined || typeof ruleId === 'string';
};

export const SCAN_SECRETS_INSTALL_HINT =
  '--scan-secrets requires the gitleaks binary on PATH (https://github.com/gitleaks/gitleaks) ' +
  '— install it with `brew install gitleaks` (macOS/Linuxbrew) or see ' +
  'https://github.com/gitleaks/gitleaks#installing for other platforms, or point ' +
  'CYPHER_BRAIN_GITLEAKS_BIN at it directly.';

// `command -v` (POSIX shell builtin, portable macOS/Linux) — same reasoning schedule.ts's
// resolvePgDumpDir already documents for pg_dump: resolves against THIS process's PATH,
// and gives one clear actionable error instead of a bare spawn ENOENT bubbling out of a
// scan step deep into a snapshot run. GITLEAKS_BIN is passed as an ARGUMENT rather than
// interpolated into the script, so a path with spaces or shell metacharacters cannot be
// re-parsed; `command -v` answers for an absolute path too (it echoes it back only when
// it is executable), so one call covers both the bare-name and the pinned-path case.
// Exported since #301: snapshot() asks this to decide whether the IMPLICIT default can
// scan, where an unresolvable scanner is a plain "no" rather than the error
// assertGitleaksAvailable() raises for an explicit request.
export async function gitleaksAvailable(): Promise<boolean> {
  try {
    const r = await run('sh', ['-c', 'command -v "$1"', 'sh', GITLEAKS_BIN]);
    return r.out.trim().length > 0;
  } catch {
    return false;
  }
}

// Fail fast, BEFORE any pg_dump/tar/staging work runs (mirrors the existing fail-fast
// checks at the top of snapshot() — a bad --out parent dir, an unresolvable recipient,
// etc.) — checked once per snapshot() call, not once per --dir source.
export async function assertGitleaksAvailable(): Promise<void> {
  if (!(await gitleaksAvailable())) throw new Error(SCAN_SECRETS_INSTALL_HINT);
}

// Scans `dir` (a directory of already-staged PLAINTEXT — the exact bytes about to be
// archived) and returns rule-ID -> count, nothing else. `--exit-code 0` deliberately
// overrides gitleaks' own default (1 when leaks are found): this keeps run()'s existing
// "reject on any non-zero exit" meaning "gitleaks itself failed to run" (bad path,
// corrupt --config, a gitleaks crash) — "leaks were found" is instead read back out of
// the JSON report body, so it can never be confused with a genuine invocation error.
export async function scanForSecrets(dir: string): Promise<SecretFinding[]> {
  // Registered for the SAME reason snapshot() registers its stage dir: the finally below
  // does not run when a signal tears the process down mid-scan.
  //
  // mkdtempSync (not the async mkdtemp) so dir-creation and the registration happen in ONE
  // tick — the identical reasoning, and identical fix, snapshot() already spells out for
  // its plaintext stage dir. An `await` between them yields to the event loop, and a signal
  // landing in that gap fires the handler while ACTIVE_SCAN_REPORT_DIR is still null,
  // leaving the just-created directory behind. Not theoretical: holding a SIGINT inside that
  // window leaked the directory on every one of 5 runs with the async call and none with this
  // one, and unheld it still surfaced about once in 30 unmodified runs locally — which is
  // what took down a CI cell of the SIGINT regression test in scripts/selftest.sh, whose
  // "cypher-brain-*" leftover glob counts this directory too.
  const reportDir = mkdtempSync(join(tmpdir(), 'cypher-brain-gitleaks-'));
  setActiveScanReportDir(reportDir);
  const reportPath = join(reportDir, 'report.json');
  try {
    await run(GITLEAKS_BIN, [
      'dir',
      '--no-banner',
      '--redact',
      '--report-format',
      'json',
      '--report-path',
      reportPath,
      '--exit-code',
      '0',
      dir,
    ]);
    // A missing/unparsable report must NOT be treated as "no findings" (fail OPEN) — gitleaks
    // itself exited 0 (only proves the scan ran, not that the report is trustworthy), so a
    // truncated write / disk-full / permissions hiccup here would otherwise let --scan-secrets
    // deny silently proceed as if the source were clean. Fail closed: surface it as a real
    // error instead.
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (e) {
      throw new Error(
        `gitleaks ran but its report at ${reportPath} could not be read/parsed (${errMsg(e)}) — refusing to treat this as "no findings"`,
      );
    }
    // Same fail-closed reasoning as the parse failure above, extended to a report that
    // parses fine but isn't the shape gitleaks' `--report-format json` actually produces
    // (a future gitleaks wrapping results in `{Results: [...]}`, or a truncated write
    // that still happens to be valid JSON, e.g. `null`/`{}`) — `for...of` over a
    // non-array would otherwise throw an unhandled TypeError instead of this function's
    // own clear error (#495).
    if (!Array.isArray(raw) || !raw.every(isGitleaksFinding)) {
      throw new Error(
        `gitleaks report at ${reportPath} was valid JSON but not the array-of-findings shape gitleaks --report-format json produces — refusing to treat this as "no findings"`,
      );
    }
    const findings: GitleaksRawFinding[] = raw;
    const counts = new Map<string, number>();
    for (const f of findings) {
      const id = f.RuleID || 'unknown';
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([rule_id, count]) => ({ rule_id, count }))
      .sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  } finally {
    // Remove FIRST, deregister only once the directory is actually gone — the mirror image
    // of the create-then-register ordering above, and the same order snapshot()'s own
    // finally uses (`await rm(stage)` then `setActiveStage(null)`). Clearing the slot
    // before the await left the second half of the same gap: a signal arriving during the
    // rm found nothing tracked and left the half-removed directory behind. A signal landing
    // DURING the rm is now handled rather than missed: the dir is still tracked, and the
    // handler's forceRmSync is idempotent against a partially-removed tree. Nothing yields
    // between the rm resolving and this clear, so the "tracked but already gone" state the
    // old ordering was avoiding lasts no turns at all.
    //
    // What this does NOT fix, because it predates and outlives this function: the guard
    // holds ONE slot per resource kind, so it is only correct for one scan at a time.
    // snapshot() satisfies that — it scans its --dir components sequentially — but mcp.ts is
    // a long-lived server that can have two snapshot_now calls in flight, where the second
    // scan's registration evicts the first and the first scan's clear pulls the slot out
    // from under the second. Every other slot in signal-guard.ts has the same shape, so the
    // fix belongs there (a per-path set) rather than here.
    await rm(reportDir, { recursive: true, force: true });
    setActiveScanReportDir(null);
  }
}

// warn: log and proceed. deny: refuse the whole snapshot. `label` is the manifest
// component name (e.g. "obsidian.tar.gz") — identifies WHICH source without ever
// surfacing the finding's own file path.
export function reportSecretFindings(label: string, findings: SecretFinding[], mode: ActiveScanMode): void {
  if (findings.length === 0) return;
  const total = findings.reduce((n, f) => n + f.count, 0);
  const summary = findings.map((f) => `${f.rule_id}×${f.count}`).join(', ');
  if (mode === 'deny') {
    throw new Error(
      `gitleaks found ${total} potential secret(s) in "${label}" (${summary}) — refusing to snapshot ` +
        `(--scan-secrets=deny). Remove/rotate them, add a .gitleaks.toml allowlist under the scanned ` +
        `source if this is a false positive, or rerun with --scan-secrets=warn to proceed anyway.`,
    );
  }
  warn(
    `gitleaks found ${total} potential secret(s) in "${label}" (${summary}) — proceeding ` +
      `(--scan-secrets=warn). This snapshot is about to be encrypted and may go to an UN-DELETABLE ` +
      `backend (Arweave/Turbo) — review before pushing.`,
  );
}
