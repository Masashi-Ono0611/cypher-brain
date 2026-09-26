---
'cypher-brain': minor
---

Add a dedicated Ethereum agent wallet keygen command for ENS integration. Use `viem` for offline secp256k1 key generation and address derivation instead of implementing wallet cryptography locally; viem is MIT-licensed. The private key is stored with the existing atomic, mode-0600 key-file path and is never printed.
