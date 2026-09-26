// Publish a just-completed push locator to one ENSv2 text record with the agent key.
import { lstat, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
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

function validateEnsPublishOptions(o: CliOptions): asserts o is EnsPublishOptions {
  if (!o.publish_ens || !o.name || !o.text_key || !o.rpc_url) {
    throw new UsageError('--publish-ens requires --name <label>, --text-key <key>, and --rpc-url <url>');
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

export async function prepareEnsPublisher(o: CliOptions): Promise<(locator: string) => Promise<void>> {
  validateEnsPublishOptions(o);
  // Same fix as #967's ens-setup.ts (Codex review on #974): clack/prompts writes to
  // stdout by default; checking only stderr let a redirected stdout hide the
  // confirmation prompt/details while input stayed live.
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error('--publish-ens requires stdin, stdout, and stderr to all be an interactive TTY');
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
    throw new Error(
      `agent wallet lacks ROLE_SET_TEXT for '${o.text_key}' on '${o.name}'; run ens-setup before pushing`,
    );
  }

  console.error(`ENS target: ${o.name} (resolver ${resolver})`);
  console.error(`Agent wallet: ${account.address}`);
  console.error(`Text key: ${o.text_key}`);
  console.error(`Sepolia RPC host: ${rpcHost}`);

  return async (locator: string): Promise<void> => {
    if (!locator || locator.includes('\n') || locator.includes('\r')) {
      throw new Error('push returned an empty or malformed locator; refusing to publish it');
    }
    // Codex review (#975): the resolver looked up above is cached in this closure. If the
    // registry's resolver for this name changes between preflight and this call (e.g. a
    // concurrent ens-setup-style re-init elsewhere), writing to the stale address can
    // still succeed (the OLD resolver checks its own roles/storage, not whether the
    // registry still points at it) and this would silently report false success.
    // Re-resolve immediately before writing and refuse if it moved.
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
        `ENS label '${o.name}' now resolves to ${currentResolver}, not the ${resolverAddress} checked earlier; refusing to publish to a stale resolver`,
      );
    }
    const nameBytes = encodeName(o.name);
    const parameters: Viem.WriteContractParameters<typeof resolverAbi> = {
      account,
      chain: sepolia,
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'setText' as const,
      args: [nameBytes, o.text_key, locator] as const,
    };
    await withRedactedRpcErrors(() =>
      publicClient.simulateContract(parameters as Viem.SimulateContractParameters<typeof resolverAbi>),
    );
    const approved = await guardedConfirm(
      `Write the locator from this push to ${o.name} text record '${o.text_key}'? Agent: ${account.address}`,
    );
    if (!approved) throw new Error(`ENS publish was not approved; push completed with locator ${locator}`);
    const hash = await withRedactedRpcErrors(() =>
      walletClient.writeContract(parameters as Viem.WriteContractParameters<typeof resolverAbi>),
    );
    const receipt = await withRedactedRpcErrors(() => publicClient.waitForTransactionReceipt({ hash }));
    if (receipt.status !== 'success') {
      throw new Error(`ENS text-record transaction reverted (${hash}); push locator remains ${locator}`);
    }
    // Confirming the value actually reads back correctly (not just that the receipt says
    // success) is #969's job (ens-verify) — not duplicated here.
    console.error(`ENS text record updated: ${hash}`);
    console.error(`Published locator: ${locator}`);
  };
}
