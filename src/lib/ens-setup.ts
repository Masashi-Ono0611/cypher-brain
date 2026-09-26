// Owner-side, one-time delegation of one ENSv2 text key to the local agent wallet.
// The owner key is entered only in a masked TTY prompt and is never written to disk.
import { lstat, readFile } from 'node:fs/promises';
import { isCancel, password, confirm } from '@clack/prompts';
import type { Address } from 'viem';
import { AGENT_WALLET_DEFAULT_PATH } from './agent-wallet.js';
import { UsageError } from './errors.js';
import type { CliOptions } from './types.js';
import { installStageSignalGuard, setActiveRawInputRestore } from './signal-guard.js';

// ENS contracts-v2 tag sepolia-deployment-2026-09-15. Deployment addresses churn;
// refresh these from ENS's deployment docs before using this command after a redeploy.
const ETH_REGISTRY = '0x657ea849311d3d5823348dded7c2aaafb3ede09e' as Address;
const ROLE_SET_TEXT = 1n << 4n;
const ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128n;

// viem is loaded on demand (not a top-level import) so that commands unrelated to the
// ENS agent wallet — doctor included — never require it to be installed, the same
// reasoning src/lib/otel.ts applies to the OpenTelemetry packages and src/lib/agent-wallet.ts
// applies to its own viem/accounts import (#966).
async function loadViem() {
  try {
    const [core, accounts, chains] = await Promise.all([
      import('viem'),
      import('viem/accounts'),
      import('viem/chains'),
    ]);
    return { ...core, ...accounts, sepolia: chains.sepolia };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error("the 'viem' package is not installed — run: npm install viem");
    }
    throw e; // a real error inside viem itself — don't misreport it as "not installed"
  }
}

async function readAgentWallet(path: string): Promise<`0x${string}`> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`agent wallet must be a regular file with no group/other permissions: ${path}`);
  }
  const privateKey = (await readFile(path, 'utf8')).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`agent wallet has an invalid Ethereum private key: ${path}`);
  }
  return privateKey as `0x${string}`;
}

async function guardedPrompt<T>(run: () => Promise<T>): Promise<T> {
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
    return await run();
  } finally {
    setActiveRawInputRestore(null);
  }
}

export async function ensSetup(o: CliOptions): Promise<void> {
  if (!o.name || !o.text_key || !o.rpc_url || o._ !== undefined || o.dirs.length || o.tables.length) {
    throw new UsageError(
      'usage: cypher-brain ens-setup --name <registered-label> --text-key <key> --rpc-url <sepolia-rpc-url>',
    );
  }
  if (!/^[a-z0-9-]+$/.test(o.name) || o.name.length < 3) {
    throw new UsageError('--name must be a single lowercase ENS label (not a full name) with at least 3 characters');
  }
  if (!o.text_key.trim() || o.text_key.length > 256) {
    throw new UsageError('--text-key must contain 1–256 characters');
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('ens-setup is interactive and requires both stdin and stderr to be a TTY');
  }

  const { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, privateKeyToAccount, sepolia } =
    await loadViem();

  const registryAbi = parseAbi(['function getResolver(string label) view returns (address)']);
  const resolverAbi = parseAbi([
    'function initialize((address account,uint256 roleBitmap)[] grants, bytes[] calls)',
    'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
    'function grantSetterRoles(bytes setter, address account) returns (bool)',
    'function setText(bytes name, string key, string value)',
  ]);

  const agentPath = AGENT_WALLET_DEFAULT_PATH;
  const agentPrivateKey = await readAgentWallet(agentPath);
  const agentAddress = privateKeyToAccount(agentPrivateKey).address;
  const { publicClient, walletClient, ownerAddress } = await (async () => {
    const entered = await guardedPrompt(() => password({ message: 'Owner wallet private key (kept in memory only):' }));
    if (isCancel(entered)) throw new Error('ens-setup cancelled');
    if (!/^0x[0-9a-fA-F]{64}$/.test(entered)) throw new Error('expected a 32-byte 0x-prefixed owner private key');
    const account = privateKeyToAccount(entered as `0x${string}`);
    const transport = http(o.rpc_url);
    return {
      ownerAddress: account.address,
      publicClient: createPublicClient({ chain: sepolia, transport }),
      walletClient: createWalletClient({ account, chain: sepolia, transport }),
    };
  })();

  const chainId = await publicClient.getChainId();
  if (chainId !== sepolia.id) throw new Error(`RPC endpoint is on chain ${chainId}; expected Sepolia (${sepolia.id})`);

  const resolver = await publicClient.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: 'getResolver',
    args: [o.name],
  });
  if (resolver === '0x0000000000000000000000000000000000000000') {
    throw new Error(
      `ENS label '${o.name}' has no registered resolver. Register it and assign its Permissioned Resolver first.`,
    );
  }
  if ((await publicClient.getCode({ address: resolver })) === undefined) {
    throw new Error(`no contract code found at the resolver returned for '${o.name}'`);
  }

  console.log(`ENS label: ${o.name}`);
  console.log(`Resolver: ${resolver}`);
  console.log(`Owner signer: ${ownerAddress}`);
  console.log(`Agent wallet: ${agentAddress}`);
  console.log(`Text key: ${o.text_key}`);
  console.log(`RPC endpoint: ${o.rpc_url}`);
  console.log('The owner key is held only in process memory and is never saved by cypher-brain.');

  let isAdmin = await publicClient.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: 'hasRootRoles',
    args: [ROLE_SET_TEXT_ADMIN, ownerAddress],
  });
  if (!isAdmin) {
    const ok = await guardedPrompt(() =>
      confirm({
        message:
          'Initialize this resolver with ROLE_SET_TEXT_ADMIN on root for the owner? This sends an on-chain transaction.',
      }),
    );
    if (isCancel(ok) || !ok) throw new Error('resolver initialization was not approved');
    const initArgs = [[{ account: ownerAddress, roleBitmap: ROLE_SET_TEXT_ADMIN }], []] as const;
    await publicClient.simulateContract({
      account: ownerAddress,
      address: resolver,
      abi: resolverAbi,
      functionName: 'initialize',
      args: initArgs,
    });
    const initHash = await walletClient.writeContract({
      address: resolver,
      abi: resolverAbi,
      functionName: 'initialize',
      args: initArgs,
    });
    const initReceipt = await publicClient.waitForTransactionReceipt({ hash: initHash });
    if (initReceipt.status !== 'success') throw new Error(`resolver initialization reverted (${initHash})`);
    isAdmin = await publicClient.readContract({
      address: resolver,
      abi: resolverAbi,
      functionName: 'hasRootRoles',
      args: [ROLE_SET_TEXT_ADMIN, ownerAddress],
    });
  }
  if (!isAdmin)
    throw new Error('owner does not have ROLE_SET_TEXT_ADMIN on resolver root; refusing to grant agent access');

  const setter = encodeFunctionData({
    abi: resolverAbi,
    functionName: 'setText',
    args: ['0x', o.text_key, ''],
  });
  const ok = await guardedPrompt(() =>
    confirm({
      message: `Grant ${agentAddress} ROLE_SET_TEXT for only '${o.text_key}' on ${o.name}? This sends an on-chain transaction.`,
    }),
  );
  if (isCancel(ok) || !ok) throw new Error('role grant was not approved');
  await publicClient.simulateContract({
    account: ownerAddress,
    address: resolver,
    abi: resolverAbi,
    functionName: 'grantSetterRoles',
    args: [setter, agentAddress],
  });
  const hash = await walletClient.writeContract({
    address: resolver,
    abi: resolverAbi,
    functionName: 'grantSetterRoles',
    args: [setter, agentAddress],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`scoped role grant reverted (${hash})`);
  console.log(`Scoped role grant confirmed: ${hash}`);
}
