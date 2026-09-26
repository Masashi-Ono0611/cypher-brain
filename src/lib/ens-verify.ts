// Verify both sides of the ENSv2 agent-wallet grant: a published value is present,
// and the same wallet cannot write a different text key. The negative call is simulated
// only; this command never broadcasts a transaction.
import { lstat, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { AGENT_WALLET_DEFAULT_PATH } from './agent-wallet.js';
import { UsageError } from './errors.js';
import {
  ETH_REGISTRY,
  ETH_REGISTRY_ABI,
  PERMISSIONED_RESOLVER_ABI,
  ROLE_SET_TEXT,
  TEXT_RESOLVER_ABI,
} from './ens-contracts.js';
import type * as Viem from 'viem';
import type * as ViemAccounts from 'viem/accounts';
import type * as ViemChains from 'viem/chains';
import type { Address } from 'viem';

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
    throw e;
  }
}

interface EnsVerifyOptions {
  name?: string;
  text_key?: string;
  rpc_url?: string;
  expected_value?: string;
}

function validate(o: EnsVerifyOptions): asserts o is EnsVerifyOptions & Required<EnsVerifyOptions> {
  if (!o.name || !o.text_key || !o.rpc_url || !o.expected_value) {
    throw new UsageError(
      'ens-verify requires --name <label>, --text-key <key>, --expected-value <locator>, and --rpc-url <url>',
    );
  }
  if (!/^[a-z0-9-]{3,63}$/.test(o.name))
    throw new UsageError('--name must be one lowercase ENS label (3–63 ASCII letters, digits, or hyphens)');
  if (!o.text_key.trim() || o.text_key.length > 256 || /[\u0000-\u001f\u007f]/.test(o.text_key)) {
    throw new UsageError('--text-key must contain 1–256 printable characters');
  }
  if (!o.expected_value.trim() || /[\r\n]/.test(o.expected_value))
    throw new UsageError('--expected-value must be a non-empty single-line value');
  try {
    const url = new URL(o.rpc_url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')))
      throw new Error();
  } catch {
    throw new UsageError(
      '--rpc-url must be an HTTPS Sepolia endpoint (or local HTTP endpoint) without embedded credentials',
    );
  }
}

function encodeName(label: string): `0x${string}` {
  const chunks: Buffer[] = [];
  for (const part of `${label}.eth`.split('.')) {
    const bytes = Buffer.from(part, 'ascii');
    if (!bytes.length || bytes.length > 63) throw new UsageError('ENS label cannot be DNS encoded');
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return `0x${Buffer.concat(chunks).toString('hex')}`;
}

async function readAccount(privateKeyToAccount: typeof ViemAccounts.privateKeyToAccount) {
  const stat = await lstat(AGENT_WALLET_DEFAULT_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(
      `agent wallet must be a regular file with no group/other permissions: ${AGENT_WALLET_DEFAULT_PATH}`,
    );
  }
  const key = (await readFile(AGENT_WALLET_DEFAULT_PATH, 'utf8')).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error(`agent wallet has an invalid Ethereum private key: ${AGENT_WALLET_DEFAULT_PATH}`);
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch {
    throw new Error(
      `agent wallet at ${AGENT_WALLET_DEFAULT_PATH} is not a valid secp256k1 private key (value withheld)`,
    );
  }
}

// Codex review (#975 follow-up on #969): matching the revert reason by substring on the
// error's echoed text is unsound — viem prints the call's own arguments in that text, so a
// --text-key crafted to CONTAIN the literal string "EACUnauthorizedAccountRoles" would make
// an unrelated simulation failure (bad RPC, wrong chain, a completely different revert)
// read as a passing negative check. Decode the actual custom error and require its resource,
// role bitmap, and account to match what THIS probe was expected to be rejected for.
function isExpectedUnauthorizedRevert(
  error: unknown,
  expected: { resource: bigint; roleBitmap: bigint; account: `0x${string}` },
  BaseErrorCtor: typeof Viem.BaseError,
  ContractFunctionRevertedErrorCtor: typeof Viem.ContractFunctionRevertedError,
): boolean {
  if (!(error instanceof BaseErrorCtor)) return false;
  const revertError = error.walk((e) => e instanceof ContractFunctionRevertedErrorCtor) as
    | InstanceType<typeof ContractFunctionRevertedErrorCtor>
    | undefined;
  if (revertError?.data?.errorName !== 'EACUnauthorizedAccountRoles') return false;
  const args = revertError.data.args as readonly [bigint, bigint, `0x${string}`] | undefined;
  if (args?.length !== 3) return false;
  const [resource, roleBitmap, account] = args;
  return (
    resource === expected.resource &&
    roleBitmap === expected.roleBitmap &&
    account.toLowerCase() === expected.account.toLowerCase()
  );
}

export async function ensVerify(o: {
  name?: string;
  text_key?: string;
  rpc_url?: string;
  expected_value?: string;
}): Promise<void> {
  validate(o);
  const viem = await loadViem();
  const {
    http,
    createPublicClient,
    keccak256,
    stringToHex,
    parseAbi,
    encodeFunctionData,
    decodeAbiParameters,
    privateKeyToAccount,
    sepolia,
    BaseError,
    ContractFunctionRevertedError,
  } = viem;
  // Codex review (#975 follow-up on #969): passing the raw human-readable ABI string
  // arrays straight to readContract/simulateContract throws at runtime — same fix as
  // ens-setup.ts / ens-publish.ts (#966–#968), required here too.
  const registryAbi = parseAbi(ETH_REGISTRY_ABI);
  const resolverAbi = parseAbi(PERMISSIONED_RESOLVER_ABI);
  const textResolverAbi = parseAbi(TEXT_RESOLVER_ABI);
  const account = await readAccount(privateKeyToAccount);
  const rpcHost = new URL(o.rpc_url).host;
  const client = createPublicClient({ chain: sepolia, transport: http(o.rpc_url) });

  // Same reasoning as ens-publish.ts's withRedactedRpcErrors (#975): viem's own
  // RPC-transport error messages can retain the full failing URL (path/query included,
  // so an API key survives). Only wrap calls whose failure is a genuine RPC/transport
  // error to report — the negative-check simulateContract call below is deliberately
  // left unwrapped so its revert data can still be decoded.
  async function withRedactedRpcErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new Error(
        `Sepolia RPC call to ${rpcHost} failed: ${e instanceof Error ? e.name : 'unknown error'} (details withheld — may contain the RPC URL's credentials)`,
      );
    }
  }

  const chainId = await withRedactedRpcErrors(() => client.getChainId());
  if (chainId !== sepolia.id) throw new Error(`RPC endpoint is on chain ${chainId}; expected Sepolia (${sepolia.id})`);
  const resolver = await withRedactedRpcErrors(() =>
    client.readContract({
      address: ETH_REGISTRY,
      abi: registryAbi,
      functionName: 'getResolver',
      args: [o.name],
    }),
  );
  if (resolver === '0x0000000000000000000000000000000000000000')
    throw new Error(`ENS label '${o.name}' has no registered resolver; run ens-setup first`);
  const resolverAddress = resolver as Address;
  const code = await withRedactedRpcErrors(() => client.getCode({ address: resolverAddress }));
  if (!code || code === '0x') throw new Error(`no resolver contract code found for ENS label '${o.name}'`);

  const name = encodeName(o.name);
  // There is no standalone `getText`/`text` call on this resolver -- verified against the
  // real ENSv2 source (see the comment on `resolve` in ens-contracts.ts). Text records are
  // only readable through the ENSIP-10 wildcard-resolution entrypoint: encode the profile
  // call (`text(node, key)`) as the inner `data`, pass the DNS-encoded `name` as resolve()'s
  // own first argument (that's what the resolver actually uses to look the record up --
  // the bytes32 inside `data` is discarded, so a zero placeholder is fine here), then
  // decode the outer `bytes` return as the ABI-encoded string it wraps.
  const zeroNode = `0x${'00'.repeat(32)}` as const;
  const innerCalldata = encodeFunctionData({
    abi: textResolverAbi,
    functionName: 'text',
    args: [zeroNode, o.text_key],
  });
  const resolved = await withRedactedRpcErrors(() =>
    client.readContract({
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'resolve',
      args: [name, innerCalldata],
    }),
  );
  const [actual] = decodeAbiParameters([{ type: 'string' }], resolved);
  if (actual !== o.expected_value) {
    throw new Error(
      `ENS positive check failed: '${o.text_key}' is ${actual ? 'set to a different value' : 'empty'}; expected-value does not match the resolver record`,
    );
  }
  console.log(`PASS positive: ${o.name} text record '${o.text_key}' matches --expected-value`);

  const resource = BigInt(keccak256(stringToHex(o.text_key)));
  const authorized = await withRedactedRpcErrors(() =>
    client.readContract({
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'hasRoles',
      args: [resource, ROLE_SET_TEXT, account.address],
    }),
  );
  if (!authorized) throw new Error(`agent wallet has no ROLE_SET_TEXT grant for '${o.text_key}' on '${o.name}'`);
  const probeKey = `${o.text_key}.scope-probe`;
  if (probeKey.length > 256) throw new UsageError('--text-key is too long to construct the out-of-scope probe key');
  const probeResource = BigInt(keccak256(stringToHex(probeKey)));
  try {
    await client.simulateContract({
      account,
      chain: sepolia,
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'setText',
      args: [name, probeKey, 'scope-check'],
    });
  } catch (error) {
    if (
      !isExpectedUnauthorizedRevert(
        error,
        { resource: probeResource, roleBitmap: ROLE_SET_TEXT, account: account.address },
        BaseError,
        ContractFunctionRevertedError,
      )
    ) {
      // Deliberately report only the error's name/kind, not its full message — the raw
      // message can embed the RPC URL (see withRedactedRpcErrors above).
      throw new Error(
        `ENS negative check failed: the out-of-scope simulation reverted for an unexpected reason (${error instanceof Error ? error.name : 'unknown error'})`,
      );
    }
    console.log(`PASS negative: out-of-scope text key '${probeKey}' reverted with EACUnauthorizedAccountRoles`);
    console.log('ENS scope verification: PASS (negative check was simulated; no transaction was broadcast)');
    return;
  }
  throw new Error(
    `ENS negative check failed: agent wallet was able to simulate setText for out-of-scope key '${probeKey}'`,
  );
}
