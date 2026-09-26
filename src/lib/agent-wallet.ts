// The ENS integration agent wallet is a narrowly-scoped signing key, separate from
// cypher-brain's age identity and from the operator's owner wallet. This command only
// creates the local keypair; granting ENS permissions and using them are separate work.
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME } from './config.js';
import { backupIdentityFile, writeKeyFile } from './keys.js';
import { exists } from './util.js';
import type { CliOptions } from './types.js';

export const AGENT_WALLET_DEFAULT_PATH = join(HOME, 'agent-wallet.key');

export async function agentWallet(o: CliOptions): Promise<void> {
  if (o._ !== 'keygen') {
    throw new Error('usage: cypher-brain agent-wallet keygen [--force]');
  }

  const outPath = AGENT_WALLET_DEFAULT_PATH;
  const hadExistingFile = await exists(outPath);
  if (hadExistingFile && !o.force) {
    throw new Error(`agent wallet already exists at ${outPath} (refusing to overwrite — pass --force to rotate it)`);
  }

  // Create and protect the home directory before writing any credential into it.
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await chmod(HOME, 0o700);

  // viem is loaded on demand (not a top-level import) so that commands unrelated to
  // the ENS agent wallet — doctor included — never require it to be installed, the
  // same reasoning src/lib/otel.ts applies to the OpenTelemetry packages.
  let generatePrivateKey: () => `0x${string}`;
  let privateKeyToAccount: (key: `0x${string}`) => { address: string };
  try {
    ({ generatePrivateKey, privateKeyToAccount } = await import('viem/accounts'));
  } catch {
    throw new Error("the 'viem' package is not installed — run: npm install viem");
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  // Keep the replacement recoverable before writeKeyFile atomically swaps it.
  const backupPath = o.force && hadExistingFile ? await backupIdentityFile(outPath) : undefined;
  await writeKeyFile(outPath, `${privateKey}\n`, 0o600, !!o.force);

  console.log(`agent wallet (PRIVATE, keep secure): ${outPath}`);
  console.log(`address (PUBLIC): ${account.address}`);
  if (backupPath) console.log(`old agent wallet backed up to: ${backupPath}`);
  console.log('The private key is stored in the file and is never printed.');
}
