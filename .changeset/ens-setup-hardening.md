---
'cypher-brain': patch
---

Bring `ens-setup` up to the same hardening bar as `ens-publish`/`ens-verify`,
found in a final review pass across the whole ENS Epic (#972):

- Both confirmation prompts (resolver initialization, and the scoped role
  grant) previously defaulted to Yes on a bare Enter -- `ens-publish`'s
  confirmation was already fixed to default No; `ens-setup`'s two prompts
  had the same on-chain-transaction risk and are now consistent.
- RPC calls were unwrapped, so a transport failure could leak the full RPC
  URL (including an Infura/Alchemy-style API key in its path/query) in the
  thrown error's message -- now redacted to the host only, matching
  `ens-publish`/`ens-verify`.
- The resolver-code check only tested for `undefined`; an address that
  exists but carries no bytecode (`getCode()` returns `'0x'`, not
  `undefined`) was accepted as if a contract were actually deployed there.
- The registry's resolver is now re-checked immediately before broadcasting
  the role-grant transaction, closing the window an interactive
  confirmation prompt can leave open for a registry change to land a grant
  on a now-stale resolver -- the same fix already applied to
  `ens-publish`'s writer.

No behavior change for the common case (a resolver that already has an
admin, on an unchanged registry); these are all defense-in-depth fixes for
paths that were already correct in the sibling commands.
