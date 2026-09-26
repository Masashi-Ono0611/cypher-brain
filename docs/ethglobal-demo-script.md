# Demo video / presentation script (draft)

Plain, simple English (aimed at an easy reading level, high-school
vocabulary), for the ETHGlobal Tokyo 2026 demo video. Read it out loud
alongside a screen recording of the live Sepolia demo (see
`docs/ethglobal-submission-draft.md` section 5 for the actual transaction
hashes to show on screen).

---

## Title

Cypher Brain times ENSv2.

This is for ETHGlobal Tokyo 2026, the ENS Prize, Continuity Track --
Track 2: Best Integration of ENSv2 into an Existing Project.

This is not a brand-new project. It is new work added to an existing
open-source project called Cypher Brain.

## What is gbrain?

First, some background.

gbrain is my own "second brain." It is a personal knowledge base. It
remembers my conversations, my decisions, and what I learn, every day.

It updates all the time.

## What Cypher Brain already does

Cypher Brain is an existing open-source project. Its job is to protect
what is inside gbrain.

It does three simple things.

One: it encrypts the content of gbrain into a single file.
Two: it stores that file somewhere outside, like Arweave.
Three: it publishes a pointer. The pointer says "here is the newest
version."

This happens every night, automatically.

## The problem we had

Here is where the problem starts.

"Automatically, every night" means a human does not do this by hand.
An AI agent does it instead.

So what do we give that agent?

The easy way is to give the agent your own wallet key. But that is not
safe. The agent could then do anything you can do. It could even move
your money.

Another way is a private server with a password. But that server can
go down. And no one outside can check that the password really works
for only one small job. You just have to trust it.

So we had no good way to give an agent a small permission, in a way
that anyone could check.

## Our solution

This is where ENSv2 comes in.

ENSv2 has a feature called Enhanced Access Control. The owner can give
one small permission to a separate agent wallet: the right to update
just one piece of information. No new smart contract needed. This uses
what ENSv2 already has.

We also built a tool called `ens-verify`. It proves the permission is
really small. It checks two things.

First: did the write really happen? Does the value match what we
expect?

Second, and more important: if the agent tries to touch something
else, does it fail? And it does fail. The blockchain itself blocks it.

## What this makes possible

Here is the result.

The owner uses their real wallet only one time, to set this up. After
that, daily updates use only the agent wallet.

If the agent wallet is ever stolen, the damage is small. It can only
touch that one small piece of information. It cannot move money. It
cannot touch anything else.

And this is not just something we say. Anyone in the world can check
it for themselves, on the blockchain.

## The full picture

Let's put it all together. There are three layers.

Layer one: gbrain. It picks what an agent can see.
Layer two: Cypher Brain. It locks that data in one encrypted file.
Layer three: ENSv2. It controls, in a way anyone can check, who is
allowed to update the pointer to that file.

This project builds layer three.

And layer three can grow. If gbrain later learns to make separate
exports for separate jobs -- one for work, one for travel, one
private -- each one can get its own key and its own agent wallet. One
agent could then touch only the work memory, another only the travel
memory. The permission system we built already works this way.

## Now let's watch it work

Step one: we register a real ENS name on the Sepolia testnet. The name
is masashi-ono-zero-six-one-one dot eth.

Step two: the owner gives the agent wallet permission for one key. We
call it "masa-brain." This key holds the pointer to the encrypted
file.

Step three: the agent wallet writes the pointer. Only the agent wallet
signs this. The owner is not involved.

Step four: we run `ens-verify`. It reads the value back and checks it
is correct. Then it tries something risky: writing to a different key,
with the same agent wallet. This must fail, and it does. The
blockchain rejects it.

We did this same thing two more times, with two more keys:
"agent-context" and "agent-endpoint[mcp]." Each one worked the same
way: write, then prove the limit.

All of this happened live, on a real testnet. Not a simulation.

That is Cypher Brain plus ENSv2. Give your AI only what it needs.
Nothing more.

Thank you.
