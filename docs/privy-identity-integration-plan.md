# Privy Identity Integration — Plan & Status

Status doc for the Privy identity work (PR #304). For usage/how-to, see
[`PRIVY_INTEGRATION.md`](./PRIVY_INTEGRATION.md); this file tracks the design,
what was fixed, and what is intentionally deferred.

## Problem

A Privy user is one account (a DID, e.g. `did:privy:cm3np…`) with **many linked
wallets** — an embedded Privy wallet plus any external wallets they connect over
time. To Formo each wallet address looks like a separate user, so an 8‑wallet
Privy user fragments into 8 users. We want them clustered into one.

## Approach

Tag **every** linked wallet with the same Privy `userId` via `identify()`.
Because the wallets share a `userId`, Formo's existing clustering merges them
server‑side — no new `alias()` API needed. This is **Phase 1 (SDK)**; the
product surfaces that consume the clustering (a Users tab, etc.) are Phase 2.

## Phase 1 — status: ✅ complete

### Public API

| Symbol | Purpose |
| --- | --- |
| `formo.identify(user, { privy: true, activeAddress?, properties? })` | **Headline.** Identify every linked wallet under the DID in one call. |
| `identifyPrivyUser(analytics, user, options?)` | Framework‑agnostic equivalent (what the flag delegates to). Returns the active wallet's `{ address, chainType }` or `undefined`. |
| `parsePrivyProperties(user)` → `{ properties, wallets }` | Low‑level parse, for custom flows. |
| Types | `PrivyUser`, `PrivyLinkedAccount`, `PrivyAccountType`, `PrivyProfileProperties`, `PrivyWalletInfo`, `IdentifyPrivyUserOptions` |

Exported from the package root and the React‑free `./core` entry. There is **no
React hook** — apps call `identify(user, { privy: true })` from their own effect
(keyed on the Privy `user`), which covers login / `linkWallet` / `unlinkWallet`.

### What each wallet sends

```ts
identify(
  { address, userId: user.id },
  { ...profileProperties, wallet_client, chain_type, is_embedded },
)
```

- `profileProperties`: email, socials (Twitter/X, Discord, GitHub, Farcaster,
  Google, …), `privyDid`, `privyCreatedAt`, parsed from `linkedAccounts`.
- Per‑wallet metadata: `wallet_client`, `chain_type`, `is_embedded`
  (`is_embedded` always present; the others omitted when Privy doesn't provide
  them).

### Gaps closed (vs. the original brief)

| Gap | Fix |
| --- | --- |
| **2 — per‑wallet metadata dropped** | `wallet_client` / `chain_type` / `is_embedded` forwarded per wallet. |
| **3 — attribution fell on an arbitrary wallet** | Only the **active** wallet updates the SDK's current address/user; the rest are clustering‑only. |
| **4 — dedup suppressed the DID re‑emit** | `userId` folded into the session dedup key, so attaching a DID to an already‑identified wallet re‑emits (and repeats still dedupe). |
| **5 — React freshness** | Integrator's own `useEffect(…, [user])` + the flag; no SDK hook. |

### Attribution model (the core design)

Every linked wallet is identified for clustering, but only **one** wallet may own
the SDK's "current address" (what later `track()`/`page()` events attribute to).

- The concrete `identify()` impl carries an **internal `setActive` flag** — *not*
  on the public `IFormoAnalytics.identify` overloads/interface. `setActive:false`
  emits + dedupes the wallet↔user link but does **not** touch `currentAddress`,
  `currentUserId`, or the user‑id cookie.
- `identifyPrivyUser` promotes exactly one wallet with `setActive:true` and marks
  the rest `setActive:false`. Ordering is irrelevant; there is no snapshot/restore.
- **Active‑wallet resolution:** `activeAddress` (matched **strictly**) →
  `user.wallet` (Privy's surfaced primary) → last‑external heuristic.
- A connected wallet that **isn't** linked in Privy is preserved: a strict,
  unmatched `activeAddress` promotes no wallet, so the current address/user are
  left untouched.
- **Chain state:** `identifyPrivyUser` clears `currentChainId` when the active
  wallet's chain namespace no longer matches the current chain id (e.g. a Solana
  wallet while an EVM chain id was current). It reconciles **before** emitting —
  so identifies aren't dropped by an `excludeChains` gate — and does so for both
  the `identify(user,{privy:true})` and direct `identifyPrivyUser()` paths.

### Validated against Privy docs

- `user.linkedAccounts` (with wallet addresses) **is** available on the frontend
  via `usePrivy()` — no server call. This is the clustering source.
- `user.wallet` is Privy's surfaced **primary** wallet (a reasonable default),
  but not a live "active" designation.
- The genuinely **active** wallet is a runtime `useWallets()` concept
  (`wallets[0]`), which the SDK can't read from outside React — hence the
  optional `activeAddress`.

### Review findings resolved (Codex, PR #304)

- Don't treat a normal identify carrying a `privy` property as the Privy form →
  dispatch requires a Privy‑user‑shaped first arg (string `id`, no `address`).
- Preserve Solana casing when matching wallets → chain‑aware compare
  (case‑insensitive for EVM `0x` hex, exact for Base58).
- Don't let `user.wallet` clobber a connected wallet → prefer the SDK's connected
  `currentAddress`; unmatched connected wallets are preserved.
- Encode user IDs before storing dedup keys → percent‑encode key components
  (a comma in an external userId no longer corrupts the comma‑joined cookie).
- Preserve the unmatched active wallet's address **and** user id → structural,
  via `setActive` (non‑active identifies never repoint either).
- Clear stale chain id when activating a Solana wallet → chain‑namespace sync.
- Reconcile the chain **before** emitting (and in the helper, not the dispatch) →
  identifies aren't dropped by a stale `excludeChains` chain id, and both entry
  points reconcile identically.
- A `userId` equal to a provider RDNS can't collide with an anonymous
  `address:rdns` dedup key → fixed 3‑component key shape when a userId is set.
- The dedup store no longer evicts identities for many‑wallet users → bounded by
  serialized cookie size (~40 identities) instead of a fixed 20‑entry cap.
- The direct `identifyPrivyUser()` form preserves a connected wallet exactly like
  the flag form → the helper itself reads the SDK's `currentAddress`.
- Clustering identifies carry the DID in the emitted event → identify events keep
  their payload `user_id` instead of being overwritten by the active‑session
  user id in `EventFactory.create()` (this one silently broke clustering for
  every non‑active wallet).
- Suppressed visitors (opt‑out / excluded host/path/timezone) → the whole sync is
  a no‑op, so chain reconciliation can't clear an excluded chain id while no
  identify runs.

### Verification

685 tests passing (unit + real‑`identify()` integration + `EventFactory.create`
user‑id resolution + session dedup); lint and full build clean.

## Phase 2 — deferred (product / backend)

These need an ingest/event contract, not just SDK code, and are out of scope for
the identify one‑liner:

- **Walletless users.** `identify()` is address‑keyed, so a Privy user with no
  linked wallet is a logged no‑op. Surfacing account identity independent of a
  wallet needs a `userId`‑keyed identify on ingest.
- **Unlink semantics.** The SDK emits positive wallet↔user links only; unlinking
  re‑runs the effect for the smaller set but there is no "unlink" event, so links
  are additive server‑side.
- **Users clustering surface.** A `/users` "Users" tab keyed on `user_id`, with a
  fallback to `anonymous_id`/wallet clustering for clusters that have no
  `user_id` yet.

## Non‑goals (by design)

- **Auto‑detecting Privy with zero integrator code.** The full `user` object
  (linked wallets) lives in Privy's React context / SDK instance; the SDK can't
  observe it from outside, and the persisted tokens carry only the DID, not the
  wallet list. The integrator passes the reactive `user`.
- **An `alias()` API.** The shared‑`userId` model already merges wallets
  server‑side.
