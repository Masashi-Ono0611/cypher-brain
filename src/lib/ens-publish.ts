// Publish a just-completed push locator to one ENSv2 text record with the agent key.
import { lstat, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { confirm, isCancel } from '@clack/prompts';
import { AGENT_WALLET_DEFAULT_PATH } from './agent-wallet.js';
import { UsageError } from './errors.js';
import { ETH_REGISTRY, ETH_REGISTRY_ABI, PERMISSIONED_RESOLVER_ABI, ROLE_SET_TEXT } from './ens-contracts.js';
import { installStageSignalGuard, setActiveRawInputRestore } from './signal-guard.js';
import type { CliOptions } from './types.js';
import type * as Viem from 'viem';
import type * as ViemAccounts from 'viem/accounts';
import type * as ViemChains from 'viem/chains';
import type { Address } from 'viem';

// viem is loaded on demand (not a top-level import) so that commands unrelated to the
// ENS agent wallet — doctor included — never require it to be installed, the same
// reasoning src/lib/otel.ts applies to the OpenTelemetry packages and src/lib/agent-wallet.ts
// / src/lib/ens-setup.ts apply to their own viem imports (#966, #967).
type LoadedViem = typeof Viem & typeof ViemAccounts & { sepolia: typeof ViemChains.sepolia };

async function loadViem(): Promise<LoadedViem> {
  try {
    const [core, accounts, chains] = await Promise.all([
      import('viem'),
      import('viem/accounts'),
      import('viem/chains'),
    ]);
    return { ...core, ...accounts, sepolia: chains.sepolia } as LoadedViem;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error("the 'viem' package is not installed — run: npm install viem");
    }
    throw e; // a real error inside viem itself — don't misreport it as "not installed"
  }
}

export interface EnsPublishOptions extends CliOptions {
  name: string;
  text_key: string;
  rpc_url: string;
}

interface EnsTextWriteOptions extends CliOptions {
  name: string;
  text_key: string;
  rpc_url: string;
}

function validateEnsTextWriteOptions(o: CliOptions): asserts o is EnsTextWriteOptions {
  if (!o.name || !o.text_key || !o.rpc_url) {
    throw new UsageError('ENS text writes require --name <label>, --text-key <key>, and --rpc-url <url>');
  }
  if (!/^[a-z0-9-]{3,63}$/.test(o.name)) {
    throw new UsageError('--name must be one lowercase ENS label (3–63 ASCII letters, digits, or hyphens)');
  }
  if (!o.text_key.trim() || o.text_key.length > 256 || /[\u0000-\u001f\u007f]/.test(o.text_key)) {
    throw new UsageError('--text-key must contain 1–256 printable characters');
  }
  try {
    const url = new URL(o.rpc_url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error();
    }
  } catch {
    throw new UsageError(
      '--rpc-url must be an HTTPS Sepolia endpoint (or local HTTP endpoint) without embedded credentials',
    );
  }
}

function validateEnsPublishOptions(o: CliOptions): asserts o is EnsPublishOptions {
  if (!o.publish_ens) throw new UsageError('--publish-ens is required');
  validateEnsTextWriteOptions(o);
}

function encodeName(label: string): `0x${string}` {
  // ENSv2's resolver accepts DNS-wire-format names. The CLI intentionally accepts
  // a single ETHRegistrar label and encodes its fully-qualified `<label>.eth` name.
  const labels = `${label}.eth`.split('.');
  const chunks: Buffer[] = [];
  for (const part of labels) {
    const bytes = Buffer.from(part, 'ascii');
    if (bytes.length === 0 || bytes.length > 63) throw new UsageError('ENS label cannot be DNS encoded');
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return `0x${Buffer.concat(chunks).toString('hex')}`;
}

async function readAgentAccount(privateKeyToAccount: typeof ViemAccounts.privateKeyToAccount) {
  const stat = await lstat(AGENT_WALLET_DEFAULT_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(
      `agent wallet must be a regular file with no group/other permissions: ${AGENT_WALLET_DEFAULT_PATH}`,
    );
  }
  const privateKey = (await readFile(AGENT_WALLET_DEFAULT_PATH, 'utf8')).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`agent wallet has an invalid Ethereum private key: ${AGENT_WALLET_DEFAULT_PATH}`);
  }
  try {
    return privateKeyToAccount(privateKey as `0x${string}`);
  } catch {
    // Same fix as #967's ens-setup.ts (Codex review on #974): viem/Noble's own error for
    // an out-of-range secp256k1 scalar includes the entire offending value — the file
    // could be corrupted into an in-range-hex-but-invalid-scalar value that the regex
    // above wouldn't catch. Never let that value reach the CLI's error output.
    throw new Error(
      `agent wallet at ${AGENT_WALLET_DEFAULT_PATH} is not a valid secp256k1 private key (value withheld from this message)`,
    );
  }
}

async function guardedConfirm(message: string): Promise<boolean> {
  installStageSignalGuard();
  setActiveRawInputRestore(() => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {}
    try {
      process.stderr.write('\x1B[?25h');
    } catch {}
  });
  try {
    // Codex review (#975): clack's confirm() defaults to Yes, so a bare Enter approves
    // broadcasting a transaction. Default to No for this destructive action instead.
    const result = await confirm({ message, initialValue: false });
    return !isCancel(result) && result;
  } finally {
    setActiveRawInputRestore(null);
  }
}

async function prepareEnsTextWriter(
  o: EnsTextWriteOptions,
): Promise<(value: string, confirmation: string, refusal: string) => Promise<void>> {
  // Same fix as #967's ens-setup.ts (Codex review on #974): clack/prompts writes to
  // stdout by default; checking only stderr let a redirected stdout hide the
  // confirmation prompt/details while input stayed live.
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error('ENS text writes require stdin, stdout, and stderr to all be an interactive TTY');
  }
  const viem = await loadViem();
  const {
    http,
    createPublicClient,
    createWalletClient,
    keccak256,
    stringToHex,
    parseAbi,
    privateKeyToAccount,
    sepolia,
  } = viem;
  // Codex review (#975): passing the raw human-readable ABI string arrays straight to
  // readContract/writeContract/simulateContract throws at RUNTIME ("Cannot use 'in'
  // operator...") even though it typechecks (viem's types accept readonly unknown[], but
  // that's not the same as its runtime ABI-item lookup accepting un-parsed strings).
  // Reproduced and confirmed: must go through parseAbi() first, same as ens-setup.ts.
  const registryAbi = parseAbi(ETH_REGISTRY_ABI);
  const resolverAbi = parseAbi(PERMISSIONED_RESOLVER_ABI);
  const account = await readAgentAccount(privateKeyToAccount);
  const rpcHost = new URL(o.rpc_url).host;
  const transport = http(o.rpc_url);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });

  // Codex review (#975): viem's own RPC-transport error messages can retain the full
  // failing URL (path/query included, so an Infura/Alchemy-style API key survives) even
  // though only the host is ever deliberately printed. Wrap every RPC call so any thrown
  // error is replaced with a host-only message before it can reach CLI diagnostics.
  async function withRedactedRpcErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new Error(
        `Sepolia RPC call to ${rpcHost} failed: ${e instanceof Error ? e.name : 'unknown error'} (details withheld — may contain the RPC URL's credentials)`,
      );
    }
  }

  const chainId = await withRedactedRpcErrors(() => publicClient.getChainId());
  if (chainId !== sepolia.id) throw new Error(`RPC endpoint is on chain ${chainId}; expected Sepolia (${sepolia.id})`);
  const resolver = await withRedactedRpcErrors(() =>
    publicClient.readContract({
      address: ETH_REGISTRY,
      abi: registryAbi,
      functionName: 'getResolver',
      args: [o.name],
    }),
  );
  if (resolver === '0x0000000000000000000000000000000000000000') {
    throw new Error(`ENS label '${o.name}' has no registered resolver; run ens-setup first`);
  }
  const resolverAddress = resolver as Address;
  const resolverCode = await withRedactedRpcErrors(() => publicClient.getCode({ address: resolverAddress }));
  if (resolverCode === undefined || resolverCode === '0x') {
    throw new Error(`no resolver contract code found for ENS label '${o.name}'`);
  }
  const hasScopedRole = await withRedactedRpcErrors(() =>
    publicClient.readContract({
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'hasRoles',
      args: [BigInt(keccak256(stringToHex(o.text_key))), ROLE_SET_TEXT, account.address],
    }),
  );
  if (!hasScopedRole) {
    throw new Error(`agent wallet lacks ROLE_SET_TEXT for '${o.text_key}' on '${o.name}'; run ens-setup first`);
  }

  console.error(`ENS target: ${o.name} (resolver ${resolver})`);
  console.error(`Agent wallet: ${account.address}`);
  console.error(`Text key: ${o.text_key}`);
  console.error(`Sepolia RPC host: ${rpcHost}`);

  async function assertResolverUnchanged(context: string): Promise<void> {
    const currentResolver = await withRedactedRpcErrors(() =>
      publicClient.readContract({
        address: ETH_REGISTRY,
        abi: registryAbi,
        functionName: 'getResolver',
        args: [o.name],
      }),
    );
    if (currentResolver.toLowerCase() !== resolverAddress.toLowerCase()) {
      throw new Error(
        `ENS label '${o.name}' now resolves to ${currentResolver}, not the ${resolverAddress} ${context}; refusing to write to a stale resolver`,
      );
    }
  }

  // Codex review (#975 follow-up on #969, second pass): an interactive confirmation
  // prompt can sit open for an arbitrary amount of time while a human reads it.
  // - Escape the literal backslash FIRST so an escaped control char (e.g. an actual ESC
  //   byte, rendered "\u{001b}") can't be confused with a value that merely CONTAINS the
  //   four printable characters "\u{001b}" — those now render as "\\u{001b}" instead.
  // - Also escape bidi override/isolate characters (U+200E/U+200F/U+202A–U+202E/
  //   U+2066–U+2069), which fall outside the C0/DEL control range but can still reorder
  //   how the rest of the line displays.
  // - A sha256 fingerprint of the FULL value (not the truncated display) is appended so
  //   two different values that happen to share the first 200 escaped characters (and
  //   the same length) still produce visibly different confirmation prompts.
  const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;
  function sanitizeForConfirmDisplay(value: string): string {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(CONTROL_OR_BIDI, (c) => `\\u{${c.codePointAt(0)?.toString(16).padStart(4, '0')}}`);
    const truncated =
      escaped.length > 200 ? `${escaped.slice(0, 200)}… (truncated, ${value.length} chars total)` : escaped;
    const fingerprint = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
    // Returns the value already wrapped in its own quotes (with the fingerprint outside
    // them) so the call site doesn't need to add its own — see the call below.
    return `'${truncated}' (sha256 fingerprint ${fingerprint})`;
  }

  return async (value: string, confirmation: string, refusal: string): Promise<void> => {
    // The registry's resolver is cached in this closure. Re-resolve immediately before
    // writing and refuse if it moved, so a stale resolver cannot accept the write.
    await assertResolverUnchanged('checked earlier');
    const nameBytes = encodeName(o.name);
    const parameters: Viem.WriteContractParameters<typeof resolverAbi> = {
      account,
      chain: sepolia,
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'setText' as const,
      args: [nameBytes, o.text_key, value] as const,
    };
    await withRedactedRpcErrors(() =>
      publicClient.simulateContract(parameters as Viem.SimulateContractParameters<typeof resolverAbi>),
    );
    const approved = await guardedConfirm(
      `${confirmation} to ${o.name} text record '${o.text_key}': ${sanitizeForConfirmDisplay(value)}? Agent: ${account.address}`,
    );
    if (!approved) throw new Error(refusal);
    // Codex review (#975 follow-up on #969): the confirmation prompt above can stay open
    // for an arbitrary amount of time while a human decides. Re-check the resolver again
    // right before broadcasting so a registry change during that window can't leave the
    // now-stale resolver silently accepting the write.
    await assertResolverUnchanged('approved above');
    const hash = await withRedactedRpcErrors(() =>
      walletClient.writeContract(parameters as Viem.WriteContractParameters<typeof resolverAbi>),
    );
    const receipt = await withRedactedRpcErrors(() => publicClient.waitForTransactionReceipt({ hash }));
    if (receipt.status !== 'success') {
      throw new Error(`ENS text-record transaction reverted (${hash}); check the resolver before retrying`);
    }
    // Confirming the value actually reads back correctly (not just that the receipt says
    // success) is #969's job (ens-verify) — not duplicated here.
    console.error(`ENS text record updated: ${hash}`);
    console.error(`Updated text key: ${o.text_key}`);
  };
}

export async function prepareEnsPublisher(o: CliOptions): Promise<(locator: string) => Promise<void>> {
  validateEnsPublishOptions(o);
  const writeText = await prepareEnsTextWriter(o);
  return async (locator: string): Promise<void> => {
    if (!locator || locator.includes('\n') || locator.includes('\r')) {
      throw new Error('push returned an empty or malformed locator; refusing to publish it');
    }
    await writeText(
      locator,
      'Write the locator from this push',
      `ENS publish was not approved; push completed with locator ${locator}`,
    );
    console.error(`Published locator: ${locator}`);
  };
}

export async function ensSetText(o: CliOptions): Promise<void> {
  validateEnsTextWriteOptions(o);
  if (o.value === undefined) throw new UsageError('ens-set-text requires --value <text>');
  if (o.publish_ens || o.expected_value !== undefined) {
    throw new UsageError('ens-set-text accepts --name, --text-key, --value, and --rpc-url only');
  }
  const writeText = await prepareEnsTextWriter(o);
  await writeText(o.value, 'Write the supplied value', 'ENS text write was not approved; no transaction was sent');
}
