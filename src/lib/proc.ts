// ---------- small process helpers (array args only — no shell, no injection) ----------
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Every spawned child registers here while running, so the signal handler can SIGKILL
// them BEFORE it rmSync's the stage / .part — otherwise a signal delivered to node
// alone (e.g. launchd stopping the service, or `kill <pid>`) leaves the children alive
// to re-create the very files the handler just removed (a still-streaming tar would
// keep feeding the pipeline after we unlinked its output). See installStageSignalGuard().
export const ACTIVE_CHILDREN: Set<ChildProcess> = new Set();

export interface RunOpts {
  input?: string;
  timeoutMs?: number;
  /**
   * Called with each COMPLETE stderr line as it arrives, instead of only being able to
   * read stderr after the child exits (#283).
   *
   * Without this, asking a child for progress is worse than not asking: rclone's
   * `--stats` would print a line per interval that nobody sees until the transfer
   * finishes (by which point it is not progress), while `err` below grew for the whole
   * transfer. So passing this ALSO switches the retained buffer to a bounded tail —
   * see ERR_TAIL_LIMIT.
   */
  onStderrLine?: (line: string) => void;
}

// How much stderr to keep for the rejection message when a caller is streaming. The
// buffer exists only to explain a non-zero exit, and the end of stderr is where a tool
// puts its error; the beginning is where a chatty tool puts its progress. Unbounded
// growth is fine for a `tar` that prints nothing and wrong for an upload that prints a
// line every few seconds for an hour.
const ERR_TAIL_LIMIT = 8192;

export interface RunResult {
  out: string;
  err: string;
}

export function run(cmd: string, args: string[], { input, timeoutMs, onStderrLine }: RunOpts = {}): Promise<RunResult> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    ACTIVE_CHILDREN.add(p);
    const doneChild = () => ACTIVE_CHILDREN.delete(p);
    let out = '',
      err = '';
    // Set when the stdin pipe errors (EPIPE from a child that exited before consuming
    // its input) — a child that then happens to exit 0 without having read all of
    // `input` must NOT read as success (multi-model review finding, #602): the exit
    // code alone can't tell "read everything" from "exited early and we never noticed".
    let stdinFailed: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      // a stuck child (e.g. a pg_dump call that never returns) must not hang us
      // forever — kill it and reject so callers can bound their own loops.
      timer = setTimeout(() => {
        p.kill('SIGKILL');
        rej(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    p.stdout?.on('data', (d) => (out += d));
    // A chunk is not a line: a stats line can arrive split across two reads, and two
    // lines can arrive in one. Hold the trailing partial until its newline shows up,
    // so a caller never sees half a line (and never has to re-assemble one itself).
    //
    // Decoded through StringDecoder rather than String(chunk): a multi-byte character
    // straddling a chunk boundary would otherwise be mangled into replacement characters
    // — measured on a split UTF-8 "€" — and these lines carry paths and error text
    //.
    const decoder = new StringDecoder('utf8');
    let pending = '';
    p.stderr?.on('data', (d) => {
      const chunk = decoder.write(d as Buffer);
      if (!onStderrLine) {
        err += chunk;
        return;
      }
      err = (err + chunk).slice(-ERR_TAIL_LIMIT);
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line !== '') onStderrLine(line);
      // A child that never emits a newline would otherwise grow `pending` for the whole
      // run, defeating the very bound this streaming path exists to provide. Flush the
      // over-long fragment as a line: a caller that cannot parse it drops it, which is
      // the same outcome as never seeing it, without the memory.
      if (pending.length > ERR_TAIL_LIMIT) {
        onStderrLine(pending);
        pending = '';
      }
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      doneChild();
      rej(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      doneChild();
      // A child that exits without a trailing newline still said something; deliver it
      // rather than swallowing the last line of a tool that does not terminate output.
      if (onStderrLine && pending !== '') {
        onStderrLine(pending);
        pending = '';
      }
      if (code === 0 && !stdinFailed) return res({ out, err });
      if (code === 0)
        return rej(new Error(`${cmd}: stdin write failed before it read all input: ${stdinFailed?.message}`));
      rej(new Error(`${cmd} exited ${code}: ${err.trim() || out.trim()}`));
    });
    if (input) {
      // EPIPE when the child exits before consuming its input — swallow on the pipe
      // end (uncaught otherwise, same hazard crypt.ts's decryptToChild() already
      // guards) but remember it, so an exit-0 child that never actually finished
      // reading doesn't get reported as success by the close handler above.
      p.stdin?.on('error', (e) => {
        stdinFailed = e;
      });
      p.stdin?.write(input);
      p.stdin?.end();
    }
  });
}

// The tar|age (snapshot) and age|tar (restore) streaming pipelines live in
// crypt.ts (encryptToFile / decryptToChild) — the encryption half runs
// in-process (typage), so only ONE child (tar) is spawned per pipeline.
