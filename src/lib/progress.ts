// progress — the one place that decides how often a long transfer reports, and what that
// line looks like (#283). Nothing here measures anything: @ardrive/turbo-sdk emits
// `events.onProgress` and rclone prints a stats line per interval, so this only rate-limits
// and formats what they already produce.
//
// Two constraints are why this is a module and not a couple of lines in each backend:
//
//  - CADENCE IS NOT A CONSTANT. The generated nightly runner appends to a log nothing
//    rotates or caps (schedule.ts), and MCP folds captured stderr into the tool RESULT — so
//    a per-second line grows a file forever in one case and a response in the other. Hence
//    often on a TTY, rarely otherwise.
//  - IT WRITES WITH console.error, NOT process.stderr.write. mcp.ts rebinds console.error
//    and captures it; a direct write bypasses that and never reaches the MCP client, which
//    is the caller least able to go look at a terminal instead.
import { installEpipeGuard } from './ui.js';
import { fmtBytes } from './util.js';

/** How often to report, by whether a human is watching. */
export const TTY_INTERVAL_MS = 2_000;
export const NON_TTY_INTERVAL_MS = 30_000;

export interface ProgressReporter {
  /**
   * Offer a sample. Emits at most one line per interval, and never two lines for the
   * same byte count — a backend may call this far more often than it should print.
   */
  report(processed: number, total: number): void;
}

export interface ProgressOpts {
  /** Overrides the TTY-derived cadence. Tests use it; callers should not. */
  intervalMs?: number;
  /** Injectable clock and sink, so the cadence rule can be tested without sleeping. */
  now?: () => number;
  write?: (line: string) => void;
}

// "36s" / "4m 12s" / "1h 02m" — seconds only below a minute, because an ETA of
// "0h 00m 36s" reads as precision this estimate does not have.
function fmtEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Exported because a child process that produces its own progress (rclone's `--stats`) has
 * to be told the interval — asking it for a line per second and dropping 29 of every 30
 * would be the same silence with more work.
 */
// Truthiness, not === false: isTTY is undefined when stderr is not a character device.
export const progressIntervalMs = (): number => (process.stderr.isTTY ? TTY_INTERVAL_MS : NON_TTY_INTERVAL_MS);

export function progressReporter(component: string, opts: ProgressOpts = {}): ProgressReporter {
  const now = opts.now ?? (() => Date.now());
  const interval = opts.intervalMs ?? progressIntervalMs();
  // console.error is a raw stderr write under the hood — a downstream reader that
  // closes its end early (e.g. `| head`) turns an uncaught EPIPE into a process
  // crash mid-transfer without this guard (same hazard as ui.ts's printMascot()).
  const write =
    opts.write ??
    ((line: string) => {
      installEpipeGuard();
      console.error(line);
    });

  // Anchored at construction, not at the first sample: anchoring later would leave the
  // first emitted line with zero elapsed time and so no rate and no ETA — and at the 30s
  // unattended cadence that line is often the only one.
  let startedAt = now();
  let anchorProcessed = 0;
  let lastEmitAt = 0;
  let lastProcessed = -1;

  return {
    report(processed: number, total: number): void {
      const t = now();
      // A counter that went backwards is a RESTARTED transfer, not a slow one — rclone
      // retries a failed copy from zero. Averaging across the abandoned attempt describes
      // neither: measured at "80% then 20%" it produced a confident "1 B/s, ETA 80s".
      if (processed < lastProcessed) {
        startedAt = t;
        anchorProcessed = processed;
        lastEmitAt = 0;
        lastProcessed = -1;
      }
      if (processed === lastProcessed) return; // a repeat would read as progress
      if (processed <= 0) return; // "started" is already said by the surrounding output
      if (lastEmitAt !== 0 && t - lastEmitAt < interval) return;

      const elapsed = (t - startedAt) / 1000;
      // Rate and ETA are OMITTED, not zeroed, until the window means something: a
      // confidently wrong "0 B/s" is worse than no estimate.
      const moved = processed - anchorProcessed;
      const rate = elapsed >= 1 && moved > 0 ? moved / elapsed : null;
      const parts: string[] = [];
      if (total > 0) parts.push(`${Math.min(100, Math.floor((processed / total) * 100))}%`);
      parts.push(total > 0 ? `${fmtBytes(processed)}/${fmtBytes(total)}` : fmtBytes(processed));
      if (rate !== null) {
        parts.push(`${fmtBytes(rate)}/s`);
        if (total > processed) parts.push(`ETA ${fmtEta((total - processed) / rate)}`);
      }
      write(`${component}: ${parts.join(' ')}`);
      lastEmitAt = t;
      lastProcessed = processed;
    },
  };
}
