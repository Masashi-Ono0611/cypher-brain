#!/usr/bin/env node
// Proof for #341: what `push` reports about credits before an irreversible paid upload.
//
// The bug being pinned is not cosmetic. On a real 459 MB monthly push, this line said
//
//   turbo: Turbo Credit balance: 0 winc (~0.00000000 AR)
//
// and the upload then spent ~4.7T winc from a Credit Share Approval and succeeded. The
// signer's OWN balance is structurally 0 in the funding flow docs/arweave-upload-runbook.md
// documents (credits bought on a browser wallet that cannot sign here, then shared to the
// JWK), so the one number the operator sees at the moment of spending was guaranteed to be
// the alarming, useless one — "did my top-up not land?" — every single time.
//
// Like selftest-progress.mjs (#283), the surface itself cannot be tested honestly: a real
// turbo upload needs a funded wallet and actual, irreversible spend. So the reporting
// logic is separated from the upload and exercised directly here, against the ACTUAL wire
// shape the payment service returns — the fixtures below are the real bodies observed
// during that push and the top-up that preceded it, with the amounts kept verbatim.
import { summarizeBalance, balanceLines, reachableCredit, insufficientFundsError } from '../src/lib/balance.ts';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const PAYER = '0x1b2c2Fda8d1fA0c734E9F0EadEaddEaa7C14c865';
const SIGNER = 'h1h8Z2iwzUAjydHhYaJAD3KgS2K1qshFIZmXtPIK830';

// Verbatim from the live service immediately after the 2026-08 push: the signer holds
// nothing, yet 626476237410 winc remain reachable through the payer's approval.
//
// The approval's expiry is the ONE field not kept verbatim. summarizeBalance() judges
// `expired` against the real clock (the property under test is "an expired approval is
// not reachable"), so the recorded 2026-08-11 expiry silently turned every reachable
// assertion below into a failure the day it lapsed — a suite that had been green for a
// week went red with no change to the code. Kept live instead: the same 7-day span the
// service granted, measured from now, so the fixture stays "current" on every run.
const EXPIRES = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const REAL_BODY = {
  winc: '0',
  balance: '0',
  controlledWinc: '0',
  effectiveBalance: '626476237410',
  givenApprovals: [],
  receivedApprovals: [
    {
      approvalDataItemId: 'JNFdO_pG3-R7DQG4ETG8iK-l1uoQo2dpWhUPxRuNlrM',
      approvedAddress: SIGNER,
      approvedWincAmount: '5344300000000',
      creationDate: '2026-08-04T14:05:07.463Z',
      payingAddress: PAYER,
      usedWincAmount: '4717823762590',
      expirationDate: EXPIRES,
    },
  ],
};

// --- the regression itself -------------------------------------------------------
{
  const bal = summarizeBalance(REAL_BODY);
  check("summarize: the signer's own balance still reads 0 (unchanged)", bal.own === '0', bal.own);
  check(
    'summarize: the effective figure is the approval-backed one, NOT the signer own balance (#341)',
    bal.effective === '626476237410',
    bal.effective,
  );

  const balanceLinesArr = balanceLines(bal, PAYER);
  const lines = balanceLinesArr.join('\n');
  // The label and amount must be on the SAME line (Codex review), not just both present
  // somewhere in the joined report: the approval-detail line below independently prints
  // "626476237410 winc left", so a regression that reintroduced #341's exact bug — the
  // reachable line itself reporting 0 — would still satisfy `lines.includes(...)` for
  // the amount via that OTHER line, and this check would still print [PASS].
  const reachableLine = balanceLinesArr.find((l) => l.includes('reachable for this upload'));
  check(
    'report: the reachable line is present and carries the amount THIS upload can draw',
    reachableLine?.includes('626476237410 winc'),
    lines,
  );
  check(
    'report: the drawn-on approval is named, with what is left and when it lapses',
    lines.includes(`via approval from ${PAYER}: 626476237410 winc left`) && lines.includes(`expires ${EXPIRES}`),
    lines,
  );
  // The exact shape of the pre-fix failure: a report whose ONLY balance figure is 0 while
  // an approval is about to fund the upload.
  const only0 = lines.split('\n').filter((l) => /balance|reachable/.test(l));
  check(
    'report: the operator is never shown 0 as the only balance figure while credit is reachable',
    !(only0.length === 1 && /: 0 winc/.test(only0[0])),
    lines,
  );
}

// --- negative control: a self-funded wallet must NOT gain a redundant second line ----
{
  const bal = summarizeBalance({ winc: '5000000000000', effectiveBalance: '5000000000000' });
  const lines = balanceLines(bal, '');
  check(
    'report: own == reachable prints ONE line, not the same number twice',
    lines.length === 1 && lines[0].includes('5000000000000 winc'),
    JSON.stringify(lines),
  );
}

// --- reachable ≠ effective: only PAID_BY's approvals count (Codex review) ----------
{
  const bal = summarizeBalance(REAL_BODY);
  // With PAID_BY unset, the approval exists but the upload cannot draw on it: reachable
  // must be the own balance (0), and the effective figure must be explained as stranded —
  // NOT presented as spendable. This is the overstatement the round-1 implementation had.
  const { winc } = reachableCredit(bal, '');
  check('reachable: with PAID_BY unset, an approval adds NOTHING to what this upload can spend', winc === 0n, winc);
  const lines = balanceLines(bal, '').join('\n');
  check(
    'report: with PAID_BY unset, the effective figure is explained as unreachable, not shown as spendable',
    lines.includes('cannot draw on') && !lines.includes('reachable for this upload'),
    lines,
  );
  check(
    'report: a PAID_BY naming a different payer claims no approval either',
    !balanceLines(bal, SIGNER).some((l) => l.includes('via approval')),
    JSON.stringify(balanceLines(bal, SIGNER)),
  );
  check(
    'report: an ETH payer in the other case still resolves to the same approval',
    balanceLines(bal, PAYER.toLowerCase()).some((l) => l.includes('via approval')),
    JSON.stringify(balanceLines(bal, PAYER.toLowerCase())),
  );
}

// --- one payer, several approvals: ALL of them are drawable and must be summed -----
{
  const second = {
    ...REAL_BODY.receivedApprovals[0],
    approvalDataItemId: 'second',
    approvedWincAmount: '1000000000010',
    usedWincAmount: '10',
    expirationDate: '2030-01-01T00:00:00.000Z',
  };
  const bal = summarizeBalance({
    ...REAL_BODY,
    effectiveBalance: '1626476237410',
    receivedApprovals: [REAL_BODY.receivedApprovals[0], second],
  });
  const { winc, approvals } = reachableCredit(bal, PAYER);
  check(
    'reachable: several approvals from the SAME payer are summed, not first-match-wins',
    winc === 626476237410n + 1000000000000n && approvals.length === 2,
    `${winc} across ${approvals.length}`,
  );
  const lines = balanceLines(bal, PAYER).join('\n');
  check(
    'report: each drawn-on approval gets its own line',
    lines.includes('626476237410 winc left') && lines.includes('1000000000000 winc left'),
    lines,
  );
}

// --- an expiry we could not read must not be printed as though it were a date ------
// It also must not COUNT: an approval whose deadline cannot be evaluated is excluded
// from reachable credit, same rule as wallet balance.
{
  const body = {
    ...REAL_BODY,
    receivedApprovals: [{ ...REAL_BODY.receivedApprovals[0], expirationDate: '2026-02-30T00:00:00.000Z' }],
  };
  const bal = summarizeBalance(body);
  check(
    'reachable: an unevaluatable expiry excludes the approval from what can be drawn',
    reachableCredit(bal, PAYER).winc === 0n,
    reachableCredit(bal, PAYER).winc,
  );
  const lines = balanceLines(bal, PAYER).join('\n');
  check('report: a rolled-over calendar date is never printed as a deadline', !lines.includes('expires'), lines);
}

// --- a body the summarizer cannot trust must THROW, so push reports why ------------
// push catches this and prints "could not read the credit balance (...)" rather than
// silently dropping the line, which is what made a missing balance indistinguishable
// from a zero one before.
{
  let threw = false;
  try {
    summarizeBalance({ winc: 12345 });
  } catch {
    threw = true;
  }
  check('summarize: a malformed winc throws rather than reporting a guessed balance', threw);
}

// --- funds check (#342): refuse ONLY the guaranteed post-signing failure -----------
{
  const bal = summarizeBalance(REAL_BODY); // reachable via PAYER: 626476237410
  const reachable = 626476237410n;

  // Exactly affordable must PASS: the check is a tripwire for the impossible, not a
  // margin policy. One winc over must refuse.
  check(
    'funds: a cost equal to the reachable credit proceeds (boundary, negative control)',
    insufficientFundsError(reachable, bal, PAYER) === null,
  );
  const refusal = insufficientFundsError(reachable + 1n, bal, PAYER);
  check('funds: one winc past the reachable bound refuses', refusal !== null);
  check('funds: the refusal names the exact shortfall', refusal?.includes('short 1 winc'), refusal);
  check(
    'funds: the refusal answers "what do I do" — both funding paths, the verify command, the runbook',
    refusal?.includes("'cypher-brain wallet address'") &&
      refusal.includes('Share Credits') &&
      refusal.includes("'cypher-brain wallet balance'") &&
      refusal.includes('docs/arweave-upload-runbook.md') &&
      refusal.includes('CYPHER_BRAIN_SKIP_FUNDS_CHECK=1'),
    refusal,
  );
  check('funds: it happens BEFORE signing, and says so', refusal?.includes('BEFORE signing'), refusal);

  // A free upload (<100KB → 0 winc) can never be refused, even on a zero balance.
  const broke = summarizeBalance({ winc: '0', effectiveBalance: '0' });
  check('funds: a free upload is never refused (negative control)', insufficientFundsError(0n, broke, '') === null);

  // The real incident's inverse: credit EXISTS but PAID_BY is unset, so none of it is
  // reachable — the refusal must point at the stranded approvals and name the fix.
  const refusalUnset = insufficientFundsError(reachable, bal, '');
  check(
    'funds: with PAID_BY unset, existing approvals are named as the likely fix',
    refusalUnset?.includes('no CYPHER_BRAIN_AR_PAID_BY is set') &&
      refusalUnset.includes('set CYPHER_BRAIN_AR_PAID_BY=<its payer address>'),
    refusalUnset,
  );

  // 'warn' mode (unattended, no TTY): the SAME facts, but it must say it is proceeding
  // and must NOT claim to abort — an unattended backup is never blocked on a balance
  // read. Both modes fire on identical conditions (negative control below).
  const warned = insufficientFundsError(reachable + 1n, bal, PAYER, 'warn');
  check(
    'funds: warn mode reports the shortfall but proceeds, and says the upload will fail if the read is accurate',
    warned?.includes('proceeding anyway') && warned.includes('WILL fail') && !warned.includes('aborting'),
    warned,
  );
  check(
    'funds: warn mode still carries the full funding guidance',
    warned?.includes('Share Credits') && warned.includes('docs/arweave-upload-runbook.md'),
    warned,
  );
  // The closing advice must not cross modes: "re-run" after an ALREADY-proceeding upload
  // invites a duplicate permanent spend, and there is nothing left to skip (Codex
  // review round 3). The abort message keeps both.
  check(
    'funds: warn mode never tells an unattended log to re-run or to skip the check',
    warned !== null && !warned.includes('re-run, or set') && !warned.includes('SKIP_FUNDS_CHECK'),
    warned,
  );
  check(
    'funds: warn mode warns that a blind re-push is a second permanent spend',
    warned?.includes('duplicate push is a second permanent spend'),
    warned,
  );
  check(
    'funds: warn mode is quiet when funds suffice (negative control)',
    insufficientFundsError(reachable, bal, PAYER, 'warn') === null,
  );
}

// --- the bypass switch parses STRICTLY (#342, Codex review) ------------------------
// CYPHER_BRAIN_SKIP_FUNDS_CHECK disables a protection, so any spelling other than
// exactly '1' — including '0', 'false', or a typo — must leave the check ON. Loose
// truthiness would turn the value that obviously means "off" into "on". Spawned per
// value because the flag is read at config-module import.
{
  const { spawnSync } = await import('node:child_process');
  const probe = (value) =>
    spawnSync(
      'node',
      [
        '--experimental-strip-types',
        '--import',
        './scripts/dev-cli-loader.mjs',
        '-e',
        "import('./src/lib/config.ts').then(c => console.log(c.SKIP_FUNDS_CHECK))",
      ],
      { env: { ...process.env, CYPHER_BRAIN_SKIP_FUNDS_CHECK: value }, encoding: 'utf8' },
    ).stdout.trim();
  check("skip: '1' enables the bypass", probe('1') === 'true', probe('1'));
  for (const v of ['0', 'false', 'yes', 'true']) {
    check(`skip: '${v}' does NOT disable the funds check (strict parse)`, probe(v) === 'false', probe(v));
  }
}

// --- the end-of-run warning summary formatter (#347) --------------------------------
{
  const { formatWarningSummary } = await import('../src/lib/warn.ts');
  check('summary: empty input produces NO block (negative control)', formatWarningSummary([]).length === 0);
  const many = formatWarningSummary(Array.from({ length: 11 }, (_, i) => `warning number ${i + 1}`));
  check(
    'summary: numbering runs 1..N and the header carries the count',
    many[1].includes('11 warning(s)') && many.some((l) => l.startsWith('   11. warning number 11')),
    JSON.stringify(many.slice(0, 3)),
  );
  const multi = formatWarningSummary(['line one\nline two']);
  const item = multi[multi.length - 1].split('\n');
  check(
    'summary: a multi-line warning indents its continuation under its own text (width-aware)',
    item[1] === `${' '.repeat('   1. '.length)}line two`,
    JSON.stringify(item),
  );
  const ten = formatWarningSummary(Array.from({ length: 10 }, () => 'a\nb'));
  const last = ten[ten.length - 1].split('\n');
  check(
    'summary: item 10 keeps its continuation aligned (two-digit prefix)',
    last[1] === `${' '.repeat('   10. '.length)}b`,
    JSON.stringify(last),
  );
}

console.log(failed ? 'PUSH BALANCE REPORT SELFTEST: FAIL' : 'PUSH BALANCE REPORT SELFTEST: PASS');
process.exit(failed ? 1 : 0);
