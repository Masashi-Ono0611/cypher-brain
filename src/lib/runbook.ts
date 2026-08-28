// The restore runbook's text, for the MCP `restore-runbook` prompt (#285).
//
// The single source is MANAGEMENT.md's "## Restore runbook" section. Keeping a second
// copy in the repository was rejected deliberately — a recovery procedure that has
// drifted from the documented one is worse than none, and this codebase has spent a
// week removing exactly that shape of bug.
//
// Two read paths, because there is no single one that works everywhere:
//
//   - SHIPPED build: MANAGEMENT.md is NOT in the package (`files: ["dist"]` — npm pack
//     emits only LICENSE, README.md, dist/*.mjs, package.json), so the section is
//     inlined at build time by scripts/build.ts through Bun.build's `define`.
//   - DEV / selftests: these run src/*.ts directly (bin/cypher-brain-mcp.mjs under
//     --experimental-strip-types), where the `define` never happened but the repository
//     — and therefore MANAGEMENT.md — is right there. So fall back to reading it.
//
// scripts/mcp-smoke.mjs asserts BOTH paths return the same text, which is the only
// thing that keeps the fallback honest.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errMsg } from './util.js';

// Replaced with a string literal by scripts/build.ts. `declare` (not a real binding) so
// the reference disappears in the bundle; `typeof` guards the dev case where it is
// genuinely undefined.
declare const __CYPHER_BRAIN_RESTORE_RUNBOOK__: string | undefined;

export const RUNBOOK_HEADING = '## Restore runbook';

/**
 * Slice one `## ` section out of MANAGEMENT.md's text, heading included, up to the next
 * `## ` heading. Shared with scripts/build.ts so the built-in and the dev-read copies
 * cannot be sliced differently.
 */
export function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  if (start === -1) return '';
  const rest = markdown.slice(start + heading.length);
  const nextIdx = rest.search(/\n## /);
  return (heading + (nextIdx === -1 ? rest : rest.slice(0, nextIdx))).trim();
}

let cached: string | null = null;

/**
 * The runbook text. Throws rather than returning something empty: a prompt that
 * silently resolves to nothing would look like a working feature while giving an agent
 * no procedure at all.
 */
export function restoreRunbook(): string {
  if (cached !== null) return cached;

  if (typeof __CYPHER_BRAIN_RESTORE_RUNBOOK__ === 'string' && __CYPHER_BRAIN_RESTORE_RUNBOOK__.length > 0) {
    cached = __CYPHER_BRAIN_RESTORE_RUNBOOK__;
    return cached;
  }

  // Dev path ONLY. From a bundled dist/mcp.mjs, `../..` resolves ABOVE the package, so
  // an unrelated MANAGEMENT.md sitting in a parent directory could be served as the
  // restore runbook — a wrong recovery procedure is worse than none (multi-model review
  // finding). So refuse unless this module is genuinely the source file it claims to be.
  const here = fileURLToPath(import.meta.url);
  if (!here.endsWith(join('src', 'lib', 'runbook.ts'))) {
    throw new Error(
      `restore runbook unavailable: this build has no inlined copy, and ${here} is not the source tree, ` +
        `so there is no trustworthy MANAGEMENT.md to fall back to. A shipped build must have it inlined ` +
        `by scripts/build.ts.`,
    );
  }
  const path = join(dirname(here), '..', '..', 'MANAGEMENT.md');
  let text: string;
  try {
    text = extractSection(readFileSync(path, 'utf8'), RUNBOOK_HEADING);
  } catch (e) {
    throw new Error(
      `restore runbook unavailable: this build has no inlined copy and ${path} could not be read (${errMsg(e)}). ` +
        `A shipped build should have it inlined by scripts/build.ts.`,
    );
  }
  if (!text) throw new Error(`restore runbook unavailable: no "${RUNBOOK_HEADING}" section found in ${path}`);
  cached = text;
  return cached;
}
