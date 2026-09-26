# Demo video / presentation script (draft)

Plain, simple English (aimed at an easy reading level), for the ETHGlobal
Tokyo 2026 demo video. Read it out loud alongside a screen recording of the
live Sepolia demo (see `docs/ethglobal-submission-draft.md` section 5 for
the actual transaction hashes to show on screen).

---

Hi. This is Scoped Brain.

AI agents need memory, but full access can expose private information
and put your wallet at risk. The broader Scoped Brain design has three
layers: gbrain selects memory sources, Cypher Brain encrypts a snapshot,
and ENS controls who can update its pointer. This demo focuses on the
ENS permission.

We use two wallets. The owner uses their wallet to grant the agent
permission for selected text keys on this resolver. Each grant applies
to that key wherever this resolver is used. The agent uses its own wallet
for later updates; the owner does not sign those writes.

Without ENSv2, you could give the agent your wallet key, letting it
sign or spend as you. Or you could rely on a central server to control
access; it can go down or block requests, and outsiders cannot verify
that its key only allows changes to one field. ENSv2 has this permission
system built in: the owner grants the agent a role for one text key,
without a custom contract. Anyone can inspect the permission, and
ens-verify demonstrates the limit by simulating a write to another key
and checking that the resolver rejects it.

Now let's watch it work.

Step one: we register an ENS name on the Sepolia testnet. It is
masashi-ono-zero-six-one-one dot eth.

Step two: the owner grants the agent permission for the "masa-brain"
key, which holds the pointer to the encrypted snapshot.

Step three: after a local file push, the agent wallet writes the pointer
with `ens-set-text`. Only the agent wallet signs this transaction.

Step four: `ens-verify` reads the value back, then simulates a write to
a different key using the same wallet. The resolver rejects that write
with `EACUnauthorizedAccountRoles`. The check proves this resolver grant
is limited to the selected text key; it does not describe other authority
the wallet might have elsewhere.

We also wrote and verified two agent-description keys: "agent-context"
and "agent-endpoint[mcp]". These transactions and the record read ran
against live Sepolia. The denied write was simulated and not broadcast.

That is Scoped Brain. Give your AI only what it needs. Nothing more.

Thank you.
