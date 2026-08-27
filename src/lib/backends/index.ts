// ---------- storage backends ----------
// A StorageBackend is { put(file) -> locator, get(locator, outFile) }. Storage
// only ever sees the *.age ciphertext. The locator is whatever the backend
// assigns: a content hash for file (known before upload), or a tx id for
// arweave (assigned AFTER upload) — the interface assumes neither.
import { fileBackend } from './file.js';
import { arweaveBackend } from './arweave.js';
import { turboBackend } from './turbo.js';
import { rcloneBackend } from './rclone.js';
import { tonBackend } from './ton.js';
import { tonProviderBackend } from './ton-provider.js';
import { didYouMean, nearestName } from '../suggest.js';
import type { StorageBackend } from '../types.js';

// #435 (Codex review): backendFor()'s dispatch used to be an if-chain naming each
// backend twice — once in the chain, once again in the "unknown backend" message's
// hand-written list — the exact kind of drift #300's suggest.ts header warns about.
// One map now IS the canonical name -> factory set: backendFor() dispatches through
// it, and its keys are also the full "declared value set" nearestName() (#425/#435)
// suggests --backend typos against — a backend added/removed here can no longer
// silently fall out of sync with either.
const BACKEND_FACTORIES: Record<string, () => StorageBackend | Promise<StorageBackend>> = {
  file: fileBackend,
  arweave: arweaveBackend,
  turbo: turboBackend,
  rclone: rcloneBackend,
  ton: tonBackend,
  'ton-provider': tonProviderBackend,
};

// The `init` wizard's interactive backend choices — NOT the complete/canonical list
// of every --backend `backendFor` below accepts (that list is BACKEND_FACTORIES'
// key set above; a NEW caller needing the full set should read it from there, not
// assume this constant is exhaustive). Exported (mirrors profiles.ts's PROFILE_NAMES) so the
// wizard prompt reads its OFFERED choices from one place instead of hand-rolling a
// second copy that could drift. Order here is also the wizard's select() MENU order
// (issue #396 Phase B) — turbo/arweave/ton-provider listed by recommendation strength
// first, `file` last (its own consent step still defaults the CURSOR to `file`
// regardless of list position — see wizard.ts — so this ordering is presentation only,
// not a change to what a bare Enter picks).
//
// `rclone` (#204) and `ton` (the SELF-HOSTED-seeder mode, src/lib/backends/ton.ts) are
// deliberately excluded from this wizard-choices list. `ton` because it needs a
// configured seeder box (CYPHER_BRAIN_TON_SSH_HOST etc.) that the wizard neither
// collects nor can verify, so offering it would produce the same fail-deep-inside-
// push() bad UX as rclone's missing --remote below — it stays reachable only via
// direct --backend ton, as the advanced/"sovereignty" path issue #396 always intended
// it to remain. `ton-provider` (the PAID, provider-market mode,
// src/lib/backends/ton-provider.ts) is NOT excluded for the same reason ton is: unlike
// ton's seeder box, ton-provider's prerequisites (CYPHER_BRAIN_TON_PROVIDER_OWNER,
// CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND) ARE presence-checkable BY the wizard the same way
// arweave/turbo's wallet is (see wizard.ts) — so it gets the same "check first, guide
// if missing" treatment those two already have, not a seeder-style exclusion.
// `rclone`'s own reasoning: unlike file/arweave/turbo/ton-provider it needs an extra
// --remote value the interactive wizard never collects, so offering it in that prompt
// would let an operator pick it, sail past the wizard's own paid-backend checks, and
// only then fail deep inside push() with a "--remote required" error (the exact
// bad-UX shape issue #161's wallet-presence check exists to avoid for arweave/turbo).
// It is still fully supported by `backendFor` below — and by the `push`/`pull`/
// `estimate` CLI commands — for direct CLI use; only the wizard's own prompt omits it.
export const BACKEND_NAMES = ['turbo', 'arweave', 'ton-provider', 'file'] as const;

export async function backendFor(name: string | undefined): Promise<StorageBackend> {
  const factory = name ? BACKEND_FACTORIES[name] : undefined;
  if (factory) return factory();
  const suggestion = name ? nearestName(name, Object.keys(BACKEND_FACTORIES)) : undefined;
  throw new Error(
    `unknown backend: ${name || '(none)'}${suggestion ? ` (${didYouMean(suggestion)})` : ''} — use --backend file|arweave|turbo|rclone|ton|ton-provider`,
  );
}
