---
'cypher-brain': patch
---

Four ways a paid push could spend more than you agreed to, or spend and never say so.

`--backend turbo` priced the ciphertext, but Turbo bills for the ANS-104 data item it
wraps around it — 1106 bytes more with this project's signer and tags (#791). The winc
quote, the `CYPHER_BRAIN_MAX_SPEND` check, the estimate shown before you consent, and the
receipt written afterwards all described bytes that were never what got charged; at the
100 KB free-upload threshold that meant a paid upload quoted as free. All four now
describe the item Turbo actually receives.

`CYPHER_BRAIN_MAX_SPEND` bounded each upload rather than the push (#797). A signed push
pays twice — once for the ciphertext, once for its `.minisig` sidecar — so two uploads
that each cleared a cap could together spend nearly twice it, having shown you only the
ciphertext's estimate. `arweave` and `turbo` now share one budget across both uploads,
the way `ton-provider` already did, and a signed push prints the sidecar's estimate and
the combined total before asking for consent.

An Arweave upload whose response was lost read as though nothing had happened (#802). The
transaction was already signed and may well have been accepted; the tx id was discarded
and a retry paid for a second one. `push` now checks the transaction it just signed: if
the network has it, the spend is recorded and reported as confirmed-but-incomplete with
the locator; if that cannot be established, the error says the outcome is uncertain and
names the tx id to check before retrying.

On `ton-provider`, the guard against re-funding a contract someone already paid for gave
up and funded anyway whenever TonAPI could not answer (#805) — on a retry, which is the
only time that guard matters, and exactly when TonAPI is most likely to be unreachable.
It now refuses instead, having spent nothing, and says so. Relatedly, a deploy broadcast
that fails after the transfer has actually landed is no longer thrown away as a plain
failure (#664): the contract is checked, a confirmed transfer is carried through to
confirmation and the ledger, and an unconfirmable one is reported as uncertain rather
than as "nothing happened".
