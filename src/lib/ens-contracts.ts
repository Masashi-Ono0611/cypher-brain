// ENS contracts-v2 Sepolia deployment from tag sepolia-deployment-2026-09-15.
// ENS testnet deployments are reset periodically; refresh this source before use
// after a redeployment. Keep the small ABI subset shared by setup and publish here.
//
// Deliberately NOT calling viem's parseAbi() at module load time: this file is
// imported from src/cli.ts's top level (via ens-publish.js), so a top-level viem
// import here would make EVERY command — doctor included — require viem to be
// resolvable. Callers pass these string arrays through their own lazily-imported
// parseAbi() instead (see ens-publish.ts / ens-setup.ts's loadViem() helpers).
import type { Address } from 'viem';

export const ETH_REGISTRY = '0x657ea849311d3d5823348dded7c2aaafb3ede09e' as Address;
export const ROLE_SET_TEXT = 1n << 4n;
export const ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128n;

export const ETH_REGISTRY_ABI = ['function getResolver(string label) view returns (address)'] as const;

export const PERMISSIONED_RESOLVER_ABI = [
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'function initialize((address account,uint256 roleBitmap)[] grants, bytes[] calls)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)',
  'function grantSetterRoles(bytes setter, address account) returns (bool)',
  'function setText(bytes name, string key, string value)',
  // There is NO standalone `getText`/`text` function callable directly on this
  // resolver — verified against the real ENSv2 source (contracts-v2, tag
  // sepolia-deployment-2026-09-15, AbstractRecordResolver.sol): text records are
  // only readable through the ENSIP-10 wildcard-resolution entrypoint below.
  // `resolve()` decodes `data`'s selector (must match ITextResolver.text's,
  // i.e. `text(bytes32,string)`), IGNORES the bytes32 arg inside `data`, and
  // instead re-derives the record from `NameCoder.namehash(name, 0)` — the
  // DNS-encoded `name` passed as resolve()'s own first argument. The bytes32
  // placeholder inside the inner calldata can be anything (it's discarded);
  // ens-verify.ts passes zero. Confirmed on-chain against the live Sepolia
  // deployment (cast call, 2026-09-27) before this fix.
  'function resolve(bytes name, bytes data) view returns (bytes)',
] as const;

// Used only to ABI-encode the inner `text(node, key)` call embedded in a
// resolve() call above -- this function is never invoked as a top-level call
// on the resolver itself (see the comment on `resolve` above).
export const TEXT_RESOLVER_ABI = ['function text(bytes32 node, string key) view returns (string)'] as const;
