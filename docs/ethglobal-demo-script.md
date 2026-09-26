# Demo video / presentation script (draft)

Plain, simple English (aimed at an easy reading level), for the ETHGlobal
Tokyo 2026 demo video. Read it out loud alongside a screen recording of the
live Sepolia demo (see `docs/ethglobal-submission-draft.md` section 5 for
the actual transaction hashes to show on screen).

---

Hi. This is Scoped Brain.

Scoped Brain is a way to keep your personal AI memory safe.

Here is the problem. AI agents need to remember things. But if we give
an agent full access to our memory, that is risky. The agent could see
too much. It could even control our whole wallet.

Scoped Brain fixes this with three layers.

Layer one: gbrain. This picks only the data an agent needs.
Layer two: Cypher Brain. This encrypts that data into one small file.
Layer three: ENS. This gives the file a name, and controls who can
update that name.

Let me show you the ENS part. This is the new part we built.

We use two wallets.

The first wallet is the owner wallet. This is you. You use it only one
time. You give one small permission to the second wallet.

The second wallet is the agent wallet. This wallet does the daily
work. It can update only one small piece of information. It cannot do
anything else.

Without ENSv2, there are two common choices. Give the agent your wallet
key, and it can sign as you and spend your funds. Or use a central server
with a database; it can go down or block requests, and other people cannot
check if its API key is limited to one field. Both choices mean trusting
someone or building custom access rules. ENSv2 lets the owner grant the
agent access to one text key, with no custom contract. Anyone can check
that grant on-chain, and ens-verify shows the agent being rejected when it
tries a different key.

Now let's watch it work.

Step one: we register a real ENS name on Sepolia testnet. The name is
masashi-ono-zero-six-one-one dot eth.

Step two: the owner gives the agent wallet permission for one key. We
call this key "masa-brain". This key will hold the pointer to the
encrypted memory file.

Step three: the agent wallet writes the pointer. The owner is not
involved this time. Only the agent wallet signs this transaction.

Step four: we run a check called ens-verify. This check does two
things.

First, it reads the value back. It confirms the write worked.

Second, it tries something risky. It tries to write to a DIFFERENT
key, using the same agent wallet. This must fail. And it does fail.
The blockchain itself blocks it.

This proves the agent wallet is safe. It can do one small job. It
cannot do more.

We also tested two more keys. One is called "agent-context". It holds
information about the agent itself. The other is called
"agent-endpoint", with the word "mcp" in brackets. It holds a server
address. Both keys worked the same way: write, then verify.

All of this happened live, on a real testnet. Not a simulation.

That is Scoped Brain. Give your AI only what it needs. Nothing more.

Thank you.
