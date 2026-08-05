# Privy Identity Integration — How It Works

How the Privy identity clustering in this branch actually behaves, and why it's
built the way it is. For usage and API reference, see
[`PRIVY_INTEGRATION.md`](./PRIVY_INTEGRATION.md).

## The problem

A Privy user is **one account (a DID) with many linked wallets** — an embedded
wallet plus any external wallets they connect over time. Formo's analytics is
address-keyed, so one person with 8 wallets becomes 8 Formo users. Retention,
conversion, and user counts are all wrong, and no single journey is visible.

## The approach

Tag **every** linked wallet with the same Privy `userId` (the DID) via
`identify()`. Because the wallets share a `userId`, Formo's existing clustering
merges them server-side. No `alias()` API.

Why N identifies rather than one carrying a wallet array: the wallet profiler is
address-keyed. It needs an event per address to create a profile and bind it to
the visitor's `anonymous_id`.

This shape is a workaround for a missing capability, not an ideal design. User
level traits (email, socials) belong to the *user*, not to each wallet — but with
no `userId`-keyed identify on ingest, the only way to land them is to copy them
onto every wallet's identify. See [Deferred](#deferred) below.

## Public API

| Symbol | Purpose |
| --- | --- |
| `formo.identify(user)` — options `{ activeAddress?, properties? }` | Identify every linked wallet under the DID in one call. |
| `identifyPrivyUser(analytics, user, options?)` | Framework-agnostic equivalent the shorthand delegates to. Resolves to the active wallet's `{ address, chainType }`, or `undefined`. |
| `parsePrivyProperties(user)` → `{ properties, wallets }` | Low-level parse, for reading a Privy user. Not for emitting identifies by hand — see the warning in the usage guide. |

Exported from the package root and the React-free `./core` entry. There is **no
React hook**: apps call `identify(user)` from their own effect
keyed on the Privy `user`, which is what makes link/unlink propagate.

## What happens on one call

`identifyPrivyUser` (`src/privy/utils.ts`) does five things in order:

1. **Bail if tracking is suppressed** (opt-out / excluded host, path, timezone).
   This must come first, because step 4 mutates chain state before anything is
   emitted — otherwise a suppressed visitor could have their chain id cleared
   with no identify to show for it.
2. **Parse `user.linkedAccounts`** into shared profile properties and the wallet
   list.
3. **Resolve the one active wallet.**
4. **Reconcile the chain** with that wallet's namespace, *before* emitting.
5. **Emit one identify per wallet**, all tagged `userId: user.id`, with
   `setActive: wallet === activeWallet`.

## Attribution

Every wallet is identified for clustering, but only **one** may own the SDK's
current address — what later `track()`/`page()` events are attributed to.

The concrete `identify()` implementation carries an internal **`setActive`**
flag, deliberately *not* on the public `IFormoAnalytics.identify` overloads.
`setActive: false` emits the event and marks dedup, but does **not** touch
`currentAddress`, `currentUserId`, or the user-id cookie. Ordering is therefore
irrelevant and there is no snapshot/restore.

Active-wallet resolution, in order:

1. **`activeAddress`** if passed — matched **strictly**;
2. else the SDK's existing **`currentAddress`** (a prior wagmi/EIP-1193
   connect) — also matched strictly;
3. else **`user.wallet`**, Privy's surfaced primary;
4. else a best-effort guess: embedded wallets deprioritized, so the last
   external wallet.

Steps 1 and 2 never fall through on a miss. A connected wallet that isn't linked
in Privy promotes *nothing*, leaving the current identity untouched — that's
what stops a clustering pass from repointing attribution away from the wallet
the user is actually transacting with.

**The `EventFactory` fix.** `EventFactory.create()` used to overwrite an
identify's payload `user_id` with the active-session user id. That stripped the
DID from every `setActive: false` event — silently breaking clustering for
exactly the wallets this feature exists to link. Identify events now keep their
own `user_id` and skip the address backfill.

## What each wallet sends

```ts
identify(
  { address, userId: user.id },
  { ...profileProperties, wallet_client, chain_type, is_embedded },
)
```

`profileProperties`, parsed from `linkedAccounts`: `privyDid`, `privyCreatedAt`,
`email`, `phone`, socials (X, Twitch, Discord, GitHub, Farcaster, Google, …),
and `customUserId`. Keys are snake_cased by the event pipeline on the wire
(`privyDid` → `privy_did`).

Account-set summaries (wallet counts, linked type lists) are deliberately **not**
sent: they're derivable server-side, and being shared across wallets they would
make every link/unlink re-emit every wallet.

**Which accounts count as wallets:** `wallet` and `smart_wallet` accounts, plus a
`cross_app` account's `embeddedWallets`/`smartWallets` arrays (e.g. Abstract
Global Wallet), which carry addresses in arrays rather than a top-level
`address` and were previously dropped entirely. Deduplicated by address —
case-insensitively for EVM, exactly for Solana — preferring a real wallet entry
over a `cross_app` placeholder regardless of account ordering.

`createdAt` is normalized: the React SDK supplies a `Date`, but a user from the
REST API or a JSON round-trip carries an ISO string or epoch number, and
`.getTime()` on those throws — which `identify()`'s outer catch would swallow,
silently emitting nothing.

## Dedup, and why it's profile-aware

Key: `(address, rdns, userId, hash(properties))`, percent-encoded and
comma-joined in a size-bounded cookie.

The **properties fingerprint** is what makes account linking work. Linking a
social leaves the wallets and the DID untouched, so without it every
already-identified wallet would dedupe and the new property would never reach
Formo until the session expired.

Writing a key **supersedes** that identity's previous entry rather than
appending, so dedup means "same as this wallet's *last* identify". A profile
that reverts (link then unlink) re-emits instead of matching a stale key, and
the cookie stays at one entry per wallet-user rather than growing one per
profile change.

Key shapes are fixed by component count — 1 `address`, 2 `address:rdns`,
3 `+userId`, 4 `+hash` — so they can't collide, and shapes 1–2 are byte-identical
to pre-`userId` keys, meaning sessions already in browsers still match.

The fingerprint mirrors `JSON.stringify`'s value semantics so it tracks what is
actually sent: `undefined`/function/symbol properties are omitted (and become
`null` as array elements), `NaN`/`Infinity` become `null`, `toJSON()` is honored
so `Date` and `URL` reflect their serialized form, and `Map`/`Set` send as `{}`.
Two payloads that serialize identically must fingerprint identically, or dedup
emits a byte-identical duplicate.

It is also **total** — it can never throw. `BigInt` and circular references,
which `JSON.stringify` rejects, get distinct markers; a throwing getter or
exotic `Proxy` degrades to pre-fingerprint dedup. This matters because the
fingerprint runs *after* active state is mutated, so a throw would leave the SDK
with mutated identity and no emitted event.

The cookie budget is measured on the **encoded** value. Components are
percent-encoded when built and `CookieStorage` encodes the joined value again,
so 37 realistic DID-bearing keys measure 3500 raw but 3956 encoded — which with
the cookie name and attributes clears the ~4KB limit, making the browser reject
the write entirely.

> **This dedup change is global**, not Privy-scoped: any `identify()` passing
> changed properties now re-emits. That is deliberate. The consequence is that a
> caller passing a volatile value (a timestamp, a random id) emits one identify
> per call instead of one per session.

## Chain reconciliation

`identifyPrivyUser` reconciles `currentChainId` with the active wallet's
namespace **before** emitting, so identifies aren't dropped by an
`excludeChains` gate on a stale chain id.

Privy omits `chainType` on `smart_wallet` and `cross_app` entries, so the EVM
namespace is inferred from a `0x` address shape when it's absent. Only
`"solana"` and `"ethereum"` are treated as known — an unrecognized or future
namespace leaves the chain id alone rather than guessing. On a genuine mismatch
the chain id is *cleared* rather than asserted, since Privy's `chainType` can't
tell us the specific chain; a real connect sets it correctly.

## Verified end to end

Against a live Privy app and a real Formo project (`j89_KJYveZUQiXn_oDDj6`),
with a user of 3 linked wallets (`did:privy:cmeh2n0rm0183jo0blts1fysn`):

**Events** — one identify per wallet, `HTTP 202`, all sharing the DID and one
`anonymous_id`:

```json
{"privy_did":"did:privy:cmeh2n0rm0183jo0blts1fysn","privy_created_at":1755518921000,
 "discord":"yosriady#0","twitter":"yosriady",
 "is_embedded":false,"wallet_client":"metamask","chain_type":"ethereum"}
```

**Attribution** — the persisted active-wallet cookie held the wagmi-active
wallet, not either of the other two.

**Link propagation** — each social link produced exactly one re-emit per wallet,
never more:

| time | identifies | wallets | twitter | discord |
| --- | --- | --- | --- | --- |
| 01:14 | 3 | 3 | — | — |
| 02:08 | 3 | 3 | ✓ | — |
| 02:09 | 3 | 3 | ✓ | ✓ |

Without the properties fingerprint the 02:08 and 02:09 waves would both have
been suppressed, since `(address, userId)` never changed.

**Stitching** — `identities` resolves the DID to exactly those 3 addresses
across 4 `anonymous_id`s; `identity_links` carries anon↔address edges predating
the DID, so clustering pulls in each wallet's prior anonymous history; and
`user_profiles_mv` shows all 3 addresses carrying the DID plus
`twitter: yosriady` and `discord: yosriady#0`.

744 unit and integration tests; lint, `tsc`, and full build clean.

## Deferred

These need an ingest/event contract, not SDK code:

- **Walletless users.** `identify()` is address-keyed, so a Privy user with no
  linked wallet is a logged no-op. A `userId`-keyed identify on ingest is also
  the real fix for copying user-level traits onto every wallet.
- **Unlink semantics.** The SDK emits positive wallet↔user links only; links are
  additive server-side with no retraction event.
- **Users clustering surface.** A `/users` tab keyed on `user_id`, falling back
  to `anonymous_id`/wallet clustering for clusters with no `user_id` yet.

## Known limitation

`BigInt` and circular values in `properties` fail at the event queue's native
`JSON.stringify`, and because the wallet is dedup-marked before emitting, that
identify is suppressed for the session. This predates the branch and affects
`track()` equally; fixing it means changing payload semantics SDK-wide.

## Non-goals

- **Auto-detecting Privy with zero integrator code.** The full `user` object
  lives in Privy's React context; the SDK can't observe it from outside, and the
  persisted tokens carry only the DID, not the wallet list.
- **An `alias()` API.** The shared-`userId` model already merges wallets
  server-side.
