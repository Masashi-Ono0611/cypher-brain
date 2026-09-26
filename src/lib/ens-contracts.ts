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
  'function getText(bytes name, string key) view returns (string)',
] as const;
