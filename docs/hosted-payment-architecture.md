# Hosted payment architecture — credit delegation, not relay (decision for #71)

A future billed hosted plan (part of the #60 epic) needs a way for a user to push
without holding their own funded Arweave wallet. This doc is the architecture-spike
deliverable #71 asked for: a decision between two ways to do that, and why. No code
changes here — this is the decision record; implementation is separate follow-up work.

**Premise**: the primitive this depends on already exists. `--paid-by` (Turbo's Credit
Share Approval, the `x-paid-by` header) shipped in PR #25 — "push using someone else's
credit" already works, cross-chain even (a client's ETH wallet pushing against an
approval funded by an Arweave JWK owner was verified end to end: 268 MB / $7.68). What
was still open was the product-level design question.

## The two options

- **(a) Relay-style**: the client uploads ciphertext to the operator's own relay, and
  the relay pays Turbo to push it on the client's behalf.
  - Pro: minimal client-side setup — no wallet address to manage.
  - Con: the user's data — ciphertext, but still — transits the operator's
    infrastructure, and the operator bears bandwidth/storage cost for every push.
- **(b) Credit-delegation-style** (an extension of the existing `--paid-by`): the
  operator only converts fiat payments into Turbo credits and issues the user a Credit
  Share Approval. The push happens directly from the client to Turbo — the operator
  never sees the artifact.
  - Pro: data never transits the operator at all — the operator never touches the
    ciphertext (it still goes to Turbo/Arweave, same as any push; that's storage's
    job), so "the operator never sees your data" stays true even for hosted users,
    the same threat-model story as the self-hosted path.
  - Con: approval lifecycle management is constrained by Turbo's own spec (below).

## Decision: (b), credit delegation

1. **Threat-model consistency**: (a) breaks the promise this project is built around —
   the operator would receive ciphertext (plus its size and timing as metadata) on
   every push. (b) keeps the operator stateless with respect to artifact content — it
   still holds real state (a credit ledger, approvals, webhook events), just never the
   pushed data itself.
2. **Operator cost**: (b) needs no ingress bandwidth, no artifact storage, no delete
   guarantees for anything it temporarily held — there's nothing to hold. (a) needs all
   of that, plus a retry queue and an availability SLO for the relay itself.
3. **Abuse is bounded either way, and (b) bounds it more cheaply**: a relay still needs
   its own per-user size/rate quota implementation. (b) gets that almost for free from
   Turbo's own `approvedWincAmount` (see below) — one field, enforced by Turbo, not by
   code this project has to maintain.
4. **(a)'s one real advantage — minimal client setup — is nearly matched by (b)**: the
   client needs a signing wallet (any chain Turbo supports; it doesn't need to be
   funded) — which means holding a private key, not just an address, since it signs
   every push. That's still a smaller ask than "trust a relay with your ciphertext,"
   but it is real setup, not zero setup — see `keygen`/`wallet create --chain <x>` for
   what this project already asks non-hosted users to do today.
5. **The client-side primitive already ships** (`--paid-by`, PR #25) — (b) is mostly an
   operator-side build, not a client-side one.

## Turbo Credit Share Approval — the lifecycle this relies on

(From the [Turbo SDK README](https://github.com/ardriveapp/turbo-sdk/blob/main/README.md)
and [docs.ardrive.io credit-sharing](https://docs.ardrive.io/docs/turbo/credit-sharing.html).)

- **Create**: `shareCredits({ approvedAddress, approvedWincAmount, expiresBySeconds })`.
  The approval is uploaded as a signed data item to Arweave; the call returns
  `{ approvalDataItemId, approvedWincAmount }`. The approved winc is locked out of the
  sharer's own balance and reserved for the recipient.
- **Cap**: `approvedWincAmount` is a **cumulative budget per approval** (no
  documented per-upload sub-cap — the whole budget is spendable in one push if the
  artifact is large enough).
- **Expiry**: `expiresBySeconds` is optional. On expiry, whatever's unused
  automatically returns to the original owner.
- **Revocation**: `revokeCredits({ revokedAddress })` revokes **all** approvals to that
  address at once, even before expiry, returning the unused balance. There's no API to
  revoke a single approval independently of the others to the same address.
- **Query**: `getCreditShareApprovals({ userAddress })` returns
  `{ givenApprovals, receivedApprovals }` for any address — the operator can poll a
  user's remaining approval server-side without the user doing anything.
- **Recipient identity**: any chain Turbo supports natively (Arweave/ETH/SOL/etc).
  Credits are only consumed when a push explicitly sets `paidBy` (the `x-paid-by`
  header), consumed in array order. The existing `turbo` backend's signer works as the
  recipient either way, no matter which chain it signs with.

## Fiat on-ramp (operator-side flow)

- `createCheckoutSession({ amount, owner })` returns a **Stripe-hosted checkout URL** —
  card payment needs a human to complete it in a browser. The cited SDK/docs don't
  document a server-to-server card-charge API; treat "fiat requires a human in a
  browser at least once" as the working assumption unless verified otherwise at
  implementation time. `owner` accepts an arbitrary address, so buying credits
  destined for someone else's wallet is possible this way too.
- `topUpWithTokens({ tokenAmount, turboCreditDestinationAddress })` is **fully
  programmatic** — AR/ETH/SOL/POL transfers, destination configurable.
- **The realistic operator flow**: take fiat via the operator's own Stripe → the
  operator holds a crypto float and auto-charges its own treasury wallet via
  `topUpWithTokens` → delegate to the user via `shareCredits`. A fully fiat-only path
  that skips holding a crypto float isn't documented in the cited sources — assume the
  float is required until proven unnecessary.
- A third variant — `owner=<the user's own wallet>` on the checkout, i.e. the user buys
  credits directly into their own wallet — is possible, but the cited docs don't
  describe any revoke or reclaim path for credits acquired this way, unlike the
  explicit `revokeCredits` API for delegated approvals. Assume it's **not** cleanly
  cancelable until verified otherwise — which would make it a poor fit for a
  subscription hosted plan.

## Abuse bounds under (b)

A delegated user can push any content, any size, up to their approval's budget — Turbo
enforces no purpose restriction beyond that. The mitigation is sizing the approval to
the plan quota: **slice `approvedWincAmount` down to a known, bounded amount per
billing period**, so blast radius from a compromised or malicious client is capped at a
known dollar figure, not "unlimited until someone notices." Approvals closest to expiry
are consumed first by default; the SDK documents `revokeCredits` as taking effect
immediately, but that's a documentation claim, not something this spike verified
against a live approval — confirm actual revoke-to-effective latency before relying on
it as a hard abuse-response guarantee.

One gap the MVP section below needs to close explicitly: **reissuing an approval each
billing period, each with its own `expiresBySeconds` grace window, can leave more than
one approval alive for the same address at once** — and since `revokeCredits` revokes
*all* approvals for an address in one call, a user's actual spendable budget at any
moment can exceed a single period's quota (whatever the current period's approval plus
any still-unexpired prior one adds up to). Sizing `approvedWincAmount` to "the quota"
only bounds exposure per approval, not per user, unless reissuance explicitly accounts
for what's still outstanding.

## Hosted MVP requirements (built on decision b)

- Collect and verify the client's signing wallet address (Arweave JWK address or an ETH
  address) at signup.
- An operator treasury wallet, auto-charged via `topUpWithTokens`, with a low-balance
  alert.
- A Stripe webhook → `shareCredits(approvedAddress=user, approvedWincAmount=<plan
  quota>, expiresBySeconds=<billing period + grace>)` issuance job. **Must be
  idempotent against Stripe's own event-delivery retries** (Stripe explicitly does not
  guarantee exactly-once delivery) — a duplicate/replayed event issuing a second
  approval for the same billing period silently doubles that user's spendable budget
  and defeats the abuse bound above. Key the issuance on Stripe's event id, not on
  "we received a webhook."
- Reissuance needs an explicit policy for the overlapping-approval gap above: either
  revoke-then-reissue on renewal (accepting a short push-blocked gap at the boundary,
  since `revokeCredits` clears everything for that address) or track and net out prior
  unexpired approvals when computing the new one's `approvedWincAmount`.
- Period-based operation as the default (reissue every billing period); cancellation,
  delinquency, and abuse all handled via `revokeCredits` — treat its documented
  immediacy as unverified until confirmed against a live approval (see above).
- Poll `getCreditShareApprovals` to watch remaining winc and warn before it's exhausted
  (avoids a push failing with no warning as the real-world UX failure mode).
- Client side needs only `--paid-by <operator wallet>` — already implemented, close to
  zero additional client-side work.
- A ledger: user ↔ wallet address ↔ `approvalDataItemId` ↔ plan, plus consumption
  history, for support and billing reconciliation.

Heartbeat monitoring, restore-drill attestation, and billing integration itself are
explicitly out of scope here — they're separate follow-up issues once this
architecture is being built against.

## Open unknowns (not resolvable from primary sources at spike time)

- The default for `expiresBySeconds` when omitted (docs say "optional" only — presumed
  no-expiry, but not documented explicitly).
- Any cap on the number of approvals per wallet (undocumented).
- Fiat top-up fee rate (the quote response has an `adjustments` field, but no
  documented rate — `getWincForFiat` can be queried ahead of time for the effective
  rate on any given amount).
