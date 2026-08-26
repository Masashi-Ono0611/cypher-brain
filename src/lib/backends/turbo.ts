// turbo backend: upload ciphertext to Arweave via a bundler (ar.io / ArDrive Turbo),
// payable with ETH/USDC — uploads <100KB are free, larger spend Turbo Credits funded to
// the signer's address (top up at app.ardrive.io with MetaMask, no key export). The data
// item is ANS-104 *bundled*, so reads reuse the arweave backend (multi-gateway, bundled-
// capable). @ardrive/turbo-sdk is heavy, so it is lazily imported ONLY when this backend
// is used (run `npm install @ardrive/turbo-sdk`).
import { stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { AR_WALLET, AR_PAID_BY, AR_MAX_SPEND, SKIP_FUNDS_CHECK } from '../config.js';
import { warnIfLooseKeyPerms, fmtBytes, errMsg, isWalletAddress, sleep, sdkImportAdvice } from '../util.js';
import { summarizeBalance, balanceLines, insufficientFundsError, type BalanceSummary } from '../balance.js';
import { warn } from '../warn.js';
import { arUsdRate, turboUsdRate, usdApprox } from '../estimate.js';
import { progressReporter } from '../progress.js';
import { arweaveBackend } from './arweave.js';
import type { StorageBackend, PutOpts, FetchShape } from '../types.js';

export function turboBackend(): StorageBackend {
  return {
    async put(file: string, opts: PutOpts = {}): Promise<string> {
      // import + wallet load live HERE (not the constructor) so a turbo PULL needs
      // neither @ardrive/turbo-sdk nor a wallet — only an upload does.
      let TurboFactory: typeof import('@ardrive/turbo-sdk').TurboFactory;
      let ArweaveSigner: typeof import('@ardrive/turbo-sdk').ArweaveSigner;
      try {
        ({ TurboFactory, ArweaveSigner } = await import('@ardrive/turbo-sdk'));
      } catch (e) {
        const problem = sdkImportAdvice(e, '@ardrive/turbo-sdk');
        if (problem !== null) throw new Error(`turbo backend: ${problem.advice}`);
        throw e;
      }
      if (!AR_WALLET)
        throw new Error(
          'turbo put needs CYPHER_BRAIN_AR_WALLET (a JWK signer; uploads <100KB are free, larger spend Turbo Credits funded to its address)',
        );
      await warnIfLooseKeyPerms(AR_WALLET, 'turbo JWK wallet (spend-capable bearer key)');
      let jwk: unknown;
      try {
        jwk = JSON.parse(await readFile(AR_WALLET, 'utf8'));
      } catch (e) {
        throw new Error(`turbo: cannot read JWK wallet at ${AR_WALLET}: ${errMsg(e)}`);
      }
      const turbo = TurboFactory.authenticated({ signer: new ArweaveSigner(jwk) });
      const abs = resolve(file);
      const { size } = await stat(abs); // stream the file (don't buffer an ~850MB brain) and give Turbo its size
      // cost estimate + balance before committing to an irreversible spend.
      // Uploads <100KB are free (0 winc); larger ones draw from Turbo Credits.
      let uploadWinc: bigint | null = null;
      // Captured for the funds check below. null = the balance could not be read, and
      // the check does not run — an unreadable payment service must not block a backup
      // (same availability posture the advisory lines take), whereas a READ balance that
      // cannot cover the cost is a guaranteed post-signing failure and is worth refusing
      // early (#342).
      let balForCheck: BalanceSummary | null = null;
      try {
        const [{ winc: uploadWincStr }] = await turbo.getUploadCosts({ bytes: [size] });
        // BigInt('') is 0n (no throw) — a malformed-but-non-throwing winc would otherwise
        // read as a free upload and slip past the cap below without ever hitting the catch.
        // Reject anything that isn't a plain non-negative integer string up front instead.
        if (typeof uploadWincStr !== 'string' || !/^\d+$/.test(uploadWincStr)) {
          throw new Error(`turbo: getUploadCosts returned a malformed winc value: ${JSON.stringify(uploadWincStr)}`);
        }
        uploadWinc = BigInt(uploadWincStr);
        process.stderr.write(
          `turbo: upload cost estimate: ${uploadWinc} winc (~${(Number(uploadWinc) / 1e12).toFixed(8)} AR, ${size} bytes)\n`,
        );
        // Human-readable USD approximation next to the native estimate (#70). arUsdRate
        // never throws (null on any failure), so a dead pricing endpoint can neither
        // block the push nor skip the CYPHER_BRAIN_MAX_SPEND cap check below.
        //
        // Priced at Turbo's OWN credit rate, not AR spot (#343). This backend spends
        // credits, and credits sell at Turbo's fiat price, fees included; the AR-spot
        // line here understated a real 459 MB push's out-of-pocket cost by ~35% ("~$8.71"
        // shown, ≈$13.1 actually paid for the credits consumed, minutes apart). AR spot
        // survives only as a labeled worse-than-this fallback when the price sheet is
        // unreachable.
        const turboRate = await turboUsdRate();
        const spotRate = turboRate === null ? await arUsdRate() : null;
        const pricing =
          turboRate !== null
            ? { rate: turboRate.ratePer1e12Winc, source: 'turbo-credit' as const }
            : spotRate !== null
              ? { rate: spotRate, source: 'ar-spot' as const }
              : null;
        if (turboRate !== null) {
          process.stderr.write(
            `turbo: approx cost: ${fmtBytes(size)} -> ${usdApprox(uploadWinc, turboRate.ratePer1e12Winc)} ` +
              `(at Turbo's credit rate ~$${turboRate.usdPerGiB.toFixed(2)}/GiB, fees included — what buying these credits with fiat costs; not a quote)\n`,
          );
        } else if (spotRate !== null) {
          process.stderr.write(
            `turbo: approx cost: ${fmtBytes(size)} -> ${usdApprox(uploadWinc, spotRate)} ` +
              `(at AR SPOT ~$${spotRate.toFixed(2)}/AR — the credit price sheet was unavailable; buying the credits with fiat typically costs more than this)\n`,
          );
        }
        // The signer's OWN balance is structurally 0 whenever the credits were bought on
        // a wallet that cannot sign here and shared to this JWK — the exact funding flow
        // docs/arweave-upload-runbook.md documents. Reporting only that number meant this
        // line read "Turbo Credit balance: 0 winc" immediately before an upload that then
        // spent ~4.7T winc from an approval and succeeded (#341, observed on a real
        // push). Report what can ACTUALLY be spent alongside it, out of the same body the
        // SDK was already returning.
        try {
          balForCheck = summarizeBalance(await turbo.getBalance(), pricing);
          for (const line of balanceLines(balForCheck, AR_PAID_BY)) process.stderr.write(`${line}\n`);
        } catch (e) {
          // Advisory output beside a cost estimate: it must never fail a push. Say WHY it
          // is missing, though — silently dropping the line (the old behaviour) leaves the
          // operator unable to tell "no balance shown" from "no balance". The write itself
          // is best-effort for the same reason: the old catch swallowed everything, and a
          // failing stderr must not become the one thing that CAN fail the push here
          // (Codex review).
          try {
            warn(`turbo: could not read the credit balance (${errMsg(e)}); proceeding`);
          } catch {
            /* a dead stderr cannot be reported to stderr */
          }
        }
      } catch (e) {
        // A cost-estimate failure (getUploadCosts reject, empty-array destructure, bad
        // BigInt conversion, ...) must NOT be treated as "proceed anyway" when a spend cap
        // is configured — that would fail-open an irreversible paid upload straight past
        // the cap the user set to protect their wallet (#105). Fail-closed here; only
        // fail-open (log + continue, pre-existing behavior) when no cap is in effect.
        if (AR_MAX_SPEND > 0n) {
          throw new Error(
            `turbo: could not estimate upload cost (${errMsg(e)}) while CYPHER_BRAIN_MAX_SPEND=${AR_MAX_SPEND} is set — aborting (fail-closed) because the spend cap cannot be verified; set CYPHER_BRAIN_MAX_SPEND=0 to disable the cap and upload uncapped`,
          );
        }
        warn(`turbo: could not estimate upload cost (${errMsg(e)}); proceeding`);
      }
      // The cap check lives OUTSIDE the estimate try/catch above so a failed estimate can
      // never suppress it (the original bug: both lived in the same try, so any exception
      // — not just the cap guard's own — fell into a catch-all "proceeding" log). When a
      // cap is set, uploadWinc being null here should be unreachable (the catch above always
      // throws in that case), but check it explicitly anyway: a future edit to that catch
      // must not be able to silently reopen the fail-open hole this fix closes (#105).
      if (AR_MAX_SPEND > 0n) {
        if (uploadWinc === null) {
          throw new Error(
            'turbo: internal error — CYPHER_BRAIN_MAX_SPEND is set but no upload cost estimate is available; refusing to proceed uncapped',
          );
        }
        if (uploadWinc > AR_MAX_SPEND) {
          throw new Error(
            `turbo: upload cost ${uploadWinc} winc exceeds CYPHER_BRAIN_MAX_SPEND=${AR_MAX_SPEND} — aborting to protect your wallet`,
          );
        }
      }
      // Funds check (#342) — like the cap check above, OUTSIDE the estimate try/catch so
      // no exception path can swallow it (#105's lesson). It runs only when BOTH facts
      // were actually established (cost estimated AND balance read): a missing estimate
      // already has its own fail-open/fail-closed policy above, and an unreadable balance
      // must not block a backup. When both are known and the cost exceeds even the UPPER
      // bound of what this configured upload can draw, the spend is headed for a refusal
      // by the payment service — just later, after minutes of signing.
      //
      // What happens next depends on who is present, because a balance read has no
      // freshness guarantee (Codex review, Critical — there is no dry-run spend API that
      // could give one), so a false positive is always possible and someone has to bear
      // it:
      //   - stderr is a TTY: a human is watching. Abort with the funding guidance — a
      //     false positive costs them one re-run, and the fix steps are on screen. The
      //     shortfall is still confirmed by a second read after a short settle first, so
      //     a top-up landing that same moment does not trip it. (TTY-ness as the "is a
      //     human watching" signal is this repo's existing pattern — progress.ts, #283.)
      //   - not a TTY (nightly runner, MCP host): nobody can act, and a wrongly blocked
      //     unattended backup would be this check causing the harm it exists to prevent.
      //     The SAME facts are written as a warning and the upload proceeds — the
      //     payment service stays the authority, exactly the pre-#342 behaviour plus an
      //     explanation the morning log never had.
      // Residual, accepted (Codex review round 3): isTTY detects a terminal, not a
      // human, so a third-party harness that runs unattended INSIDE a PTY would get
      // attended semantics and could see an abort. Both first-party unattended paths
      // are structurally non-TTY — the schedule runner redirects stderr to its log
      // (exec >>"$LOG" 2>&1) and MCP stdio is piped — and no stronger signal exists
      // short of a config knob nobody would discover before it mattered; such a
      // harness can set CYPHER_BRAIN_SKIP_FUNDS_CHECK=1.
      // A re-read that ERRORS falls open (proceed): same availability rule as an
      // unreadable first read. CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 (strictly '1') remains
      // the attended-path override, documented in the refusal itself.
      if (uploadWinc !== null && balForCheck !== null && !SKIP_FUNDS_CHECK) {
        if (insufficientFundsError(uploadWinc, balForCheck, AR_PAID_BY) !== null) {
          if (!process.stderr.isTTY) {
            const warning = insufficientFundsError(uploadWinc, balForCheck, AR_PAID_BY, 'warn');
            // warn(), not a raw write (#347): this is THE line an unattended morning
            // log exists to carry, and raw stderr bypasses the MCP capture.
            if (warning !== null) warn(warning);
          } else {
            // The throw sits OUTSIDE the try so the re-read's failure handling can never
            // catch the refusal itself — no string-matching a message to tell them apart.
            let confirmed: string | null = null;
            let rereadOk = false;
            try {
              await sleep(2000);
              confirmed = insufficientFundsError(
                uploadWinc,
                summarizeBalance(await turbo.getBalance(), null),
                AR_PAID_BY,
              );
              rereadOk = true;
            } catch (e) {
              process.stderr.write(
                `turbo: a shortfall was seen but the confirming re-read failed (${errMsg(e)}) — proceeding; the payment service is the authority\n`,
              );
            }
            if (rereadOk && confirmed !== null) throw new Error(confirmed);
            if (rereadOk)
              process.stderr.write(
                'turbo: the first balance read showed a shortfall but a re-read shows sufficient credit (a top-up settling) — proceeding\n',
              );
          }
        }
      }
      // paidBy (x-paid-by header): when set, Turbo pays from a Credit Share Approval the
      // named address granted THIS signer, before the signer's own balance. It funds the
      // CLI path when credits were bought on a wallet we can't sign with (e.g. MetaMask)
      // and shared to this JWK. Not URL-interpolated (header only), but sanity-check the
      // shape (Arweave/Ethereum/Solana address) to reject header-breaking input.
      const dataItemOpts: { tags: { name: string; value: string }[]; paidBy?: string[] } = {
        tags: [
          { name: 'App-Name', value: 'cypher-brain' },
          { name: 'Content-Type', value: 'application/octet-stream' },
        ],
      };
      if (AR_PAID_BY) {
        if (!isWalletAddress(AR_PAID_BY))
          throw new Error(
            `turbo: CYPHER_BRAIN_AR_PAID_BY must be a plain wallet address (Arweave/Ethereum/Solana): ${AR_PAID_BY}`,
          );
        dataItemOpts.paidBy = [AR_PAID_BY];
      }
      // Progress (#283). The SDK has emitted these since v1.26.0 and we require ^1.42.0,
      // so nothing here measures anything — we were simply never subscribing, and a
      // brain-sized upload was minutes of silence. `step` distinguishes the signing pass
      // from the upload pass; both move bytes and both can be slow on a large file, so
      // both are reported, labelled, rather than silently sharing one percentage that
      // appears to go backwards when the second pass starts from zero.
      // One reporter PER STEP, each anchoring its own rate window when it is created —
      // i.e. at that step's first event. Sharing one start time across steps looked
      // tidier and was wrong: the SDK's counters restart per step, so an upload that
      // begins after 90s of signing would be divided by 91s and report a rate an order
      // of magnitude too low with an ETA to match. The
      // cost of getting this right is that each step's FIRST line has no rate yet,
      // which is the honest answer — at that instant nothing has been observed moving.
      const reporters = new Map<string, ReturnType<typeof progressReporter>>();
      const onProgress = ({
        processedBytes,
        totalBytes,
        step,
      }: {
        processedBytes: number;
        totalBytes: number;
        step?: string;
      }) => {
        const label = `turbo ${step ?? 'upload'}`;
        let r = reporters.get(label);
        if (!r) {
          r = progressReporter(label);
          reporters.set(label, r);
        }
        r.report(processedBytes, totalBytes);
      };
      const res = await turbo.uploadFile({
        fileStreamFactory: () => createReadStream(abs),
        fileSizeFactory: () => size,
        dataItemOpts,
        events: { onProgress },
      });
      if (!res?.id) throw new Error(`turbo upload returned no data item id: ${JSON.stringify(res).slice(0, 200)}`);
      // #232: persist Turbo's own upload response AS-IS (its official receipt-
      // persistence recommendation — the SDK does not separately restate a
      // "final amount charged" field). `uploadWinc` is the pre-flight estimate that
      // actually gated this specific upload (the CYPHER_BRAIN_MAX_SPEND check above,
      // moments before signing) — the closest thing to "actual cost" this response
      // surfaces; null only if that estimate itself could not be obtained (an
      // uncapped push proceeding despite a failed pre-flight query).
      opts.onReceipt?.(res, uploadWinc !== null ? { amount: String(uploadWinc), unit: 'winc' } : null);
      return res.id; // 43-char data item id — retrievable like any bundled item
    },
    // reads are identical to the arweave backend (Turbo items are bundled). Pure
    // delegation, so a turbo PULL needs neither @ardrive/turbo-sdk nor a wallet —
    // the "a fresh machine needs only the tx id" recovery property holds.
    get(locator: string, out: string, expect?: FetchShape): Promise<void> {
      // Forwarded, not dropped: turbo uploads through its own SDK but READS through the
      // arweave gateway, so the shape gate that decides whether a body is the object or a
      // soft-404 lives over there — and a sidecar fetch that arrived here as `age` would be
      // refused for not being ciphertext (#318).
      return arweaveBackend().then((b) => b.get(locator, out, expect));
    },
  };
}
