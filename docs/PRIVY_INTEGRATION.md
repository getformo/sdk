# Privy Integration for Formo Analytics SDK

## Overview

[Privy](https://privy.io) gives each user a single account (identified by a
Privy DID such as `did:privy:cm3np...`) that can have **many linked wallets** -
an embedded Privy wallet plus any external wallets (MetaMask, Rainbow, Coinbase,
smart wallets, Solana wallets, …) the user connects over time.

To Formo, each of those wallet addresses looks like a different user. The Privy
integration fixes that: it tags **every** linked wallet with the same Privy
`userId`, so Formo can cluster them server-side into one user. Attach a wallet
today, connect three more next week - they all roll up under the same identity.

```
                 Privy user (did:privy:abc…)
        ┌───────────────┬───────────────┬───────────────┐
   embedded 0x11…   MetaMask 0x22…  Rainbow 0x33…   Solana 9xQ…
        └───────────────┴───────────────┴───────────────┘
   identify({ address, userId: "did:privy:abc…" }) for each wallet
                              ↓
              Formo clusters them into one user
```

The whole thing is a single `identify(user)` call - a one-line
replacement for hand-rolling an `identify()` loop over the linked wallets.

## Quick start (React)

Pass the `usePrivy()` user straight to `identify()`. Call it from
an effect that runs when the user changes, so login, `linkWallet`, and
`unlinkWallet` all keep Formo's identity in sync. No separate helper or hook.

```tsx
import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useFormo } from "@formo/analytics";

function AnalyticsIdentity() {
  const formo = useFormo();
  const { user, authenticated } = usePrivy();

  useEffect(() => {
    if (formo && authenticated && user) {
      formo.identify(user);
    }
  }, [formo, authenticated, user]);

  return null;
}
```

That single `identify(user)` call identifies **every** wallet
linked to the Privy user under the user's DID, forwards each wallet's metadata,
and pins event attribution to the active wallet.

> The effect above is yours to own - key it on `user` so it re-runs on login and
> on every link/unlink. Dedup makes re-running *safe* (no duplicate events), but
> not *free*: each run still re-parses the linked accounts, walks every wallet,
> and fingerprints properties. Privy recreates `user` on many renders, so for a
> user with several linked wallets prefer a stable dependency that still changes
> when the profile does:
>
> ```ts
> // Re-runs on login, link, and unlink - not on every render.
> const identityKey = user
>   ? `${user.id}:${user.linkedAccounts?.length ?? 0}`
>   : null;
>
> useEffect(() => {
>   if (formo && authenticated && user) {
>     formo.identify(user);
>   }
> }, [formo, authenticated, identityKey]);
> ```
>
> If you also pass `activeAddress`, derive it as a string (e.g.
> `wallets[0]?.address`) rather than depending on the `wallets` array, which is a
> new reference on most renders.

## How it works

`identify()` recognizes a Privy user by shape - a string `id` and no `address` -
and expands `user.linkedAccounts`, emitting one identify per linked wallet under
the shared DID. No flag is needed: the two forms are mutually exclusive, because
an address-keyed identify always carries an `address` and a Privy user never
does. The Privy-specific logic lives in the SDK's Privy module; the core
`identify()` just dispatches to it.

Only the **active** wallet updates the SDK's current address/user (what later
events are attributed to). The other linked wallets are recorded purely for
clustering and never repoint attribution - so a wallet you've already connected
(even one that isn't linked in Privy) is left alone. When the active wallet is on
a different chain namespace than the current chain id (e.g. a Solana wallet while
an EVM chain was current), the mismatched chain id is cleared so events aren't
paired with the wrong chain.

## Apps with both Privy and non-Privy users

If some users authenticate through Privy and others connect a wallet directly,
branch on which identity you actually have. The two forms take different inputs,
so the conditional falls out naturally:

```tsx
const { user } = usePrivy();      // null when the session isn't a Privy one
const { address } = useAccount(); // plain wallet connect
const formo = useFormo();

useEffect(() => {
  if (!formo) return;

  if (user) {
    // Privy session: identifies every linked wallet under the DID.
    formo.identify(user);
  } else if (address) {
    // Plain wallet session: the single connected address.
    formo.identify({ address });
  }
}, [user, address, formo]);
```

**Check `user` first.** A Privy session usually *also* has a wagmi `address`, so
testing `address` first would send that user down the plain path and lose the
clustering - the exact fragmentation this integration exists to prevent.

Use `else if` rather than two independent `if`s. Both branches would otherwise
fire for a Privy user, emitting an extra identify for the connected wallet with
no DID attached. That isn't harmful - the DID-tagged identify still clusters the
wallet - but it's a redundant event.

This assumes `PrivyProvider` is mounted for every session, with `user` simply
null for non-Privy ones. If your app mounts the provider conditionally, you
can't call `usePrivy()` unconditionally, and the branch has to live above
whichever component owns the Privy context.

## Framework-agnostic usage

`identify()` is not React-specific. Obtain the Privy user however your
framework's Privy integration provides it and pass it straight in:

```ts
// `user` is Privy's user object from whatever binding you use: React's
// usePrivy(), a Vue/Svelte store, or `privy.user` from the core SDK.
if (user) {
  await formo.identify(user, {
    activeAddress: connectedWallet?.address, // optional; see "attribution" below
  });
}
```

The same call is available from the React-free `core` entry.

### Signature

```ts
identify(
  user: PrivyUser,
  options?: {
    activeAddress?: string;               // active/connected wallet
    properties?: IFormoEventProperties;   // merged into every identify call
  }
): Promise<void>
```

## What gets sent

For each linked wallet, the SDK calls:

```ts
formo.identify(
  { address, userId: user.id },
  {
    ...profileProperties, // email, socials, privyDid, privyCreatedAt, …
    wallet_client,        // e.g. "metamask", "privy", "rainbow"
    chain_type,           // e.g. "ethereum", "solana"
    is_embedded,          // true for the Privy embedded wallet
  }
);
```

Only the active wallet takes over event attribution; the other linked wallets
are recorded purely for clustering and never become the current address (see
[attribution](#event-attribution-and-the-active-wallet) below).

The shared **profile properties** are parsed from the Privy user's linked
accounts (see [`parsePrivyProperties`](#advanced-parseprivyproperties)):

| Property | Source |
| --- | --- |
| `privyDid`, `privyCreatedAt` | The Privy user itself |
| `email`, `phone` | Linked `email` / `phone` account |
| `google`, `apple`, `twitter`, `twitch`, `discord`, `github`, `linkedin`, `spotify`, `tiktok`, `instagram`, `line`, `telegram`, `farcaster` | Linked social accounts |
| `customUserId` | A linked `custom_auth` account |

Each property is omitted when Privy doesn't supply it; only `privyDid` is
always present.

Account-set summaries (wallet counts, a list of linked account types) are
deliberately **not** sent. They're derivable server-side from the per-wallet
identifies, and because such a property would be shared across every wallet,
any link or unlink would change it for all of them and re-emit every wallet.

**Which accounts count as wallets:** `wallet` and `smart_wallet` accounts, plus
the `embeddedWallets` and `smartWallets` of a `cross_app` account (e.g. Abstract
Global Wallet), which carry their addresses in arrays rather than a top-level
`address`. Wallets are deduplicated by address (case-insensitively for EVM, so
an address linked as both a `wallet` and a `smart_wallet` is identified once).

The **per-wallet metadata** (`wallet_client`, `chain_type`, `is_embedded`) is
attached per-address, so you can tell an embedded wallet apart from an external
one, and an Ethereum wallet apart from a Solana one, in your analytics.
`wallet_client` and `chain_type` are omitted when Privy doesn't provide them;
`is_embedded` is always present.

> **Changed properties re-emit.** Identify events are deduped per
> `(wallet, user, properties)` per session (see
> [below](#when-identity-re-emits)), so passing changed `options.properties`
> updates the profile rather than being swallowed. The flip side: a property
> whose value changes on every call (a timestamp, a random id, a re-computed
> object) makes every identify a new event. Pass stable identity metadata here
> and put volatile values on your own `track()` events.

## Event attribution and the active wallet

A Privy user's `linkedAccounts` lists **every** wallet they've ever linked - not
which one they're using right now. `identify()` also updates the SDK's "current
address" (the wallet later events are attributed to), so the sync has to pick
exactly **one** active wallet; the rest are recorded for clustering without
touching attribution. The active wallet is chosen, in order:

1. **`activeAddress`**, if you pass it (an optional override - e.g. the connected
   wallet from `useWallets()[0]?.address` or your wagmi account, which reflects
   the live active wallet most precisely). It's matched **strictly**: if the
   address you pass isn't one of the linked wallets, the sync promotes *no*
   wallet and leaves your current address untouched.
2. else the SDK's existing **`currentAddress`** - the wallet Formo already
   treats as active from a prior wagmi/EIP-1193 connect. Matched just as
   strictly: if it isn't one of the linked wallets, no wallet is promoted and
   the current identity is left alone rather than falling through to
   `user.wallet`. This is what stops the clustering pass from repointing
   attribution away from a wallet the user is actually connected with;
3. else **`user.wallet`** - the primary wallet Privy surfaces on the user object,
   so `identify(user)` needs no argument at all;
4. else a best-effort guess: embedded (Privy) wallets deprioritized, so the last
   external wallet.

Because only the active wallet repoints attribution (via an internal flag, not a
public `identify()` option), a wallet you've already connected is never
clobbered by the clustering identifies. In practice you can just call
`formo.identify(user)`: if the SDK already tracks a connected
wallet it's kept; otherwise it falls to Privy's primary. Pass `activeAddress`
only to pin attribution to a specific wallet.

## When identity re-emits

Formo deduplicates identify events per session, keyed on the wallet address, the
`userId`, and a fingerprint of the properties. So:

The key records each wallet-user's **latest** state, not every state it has ever
had - so dedup means "same as this wallet's last identify", and a profile that
reverts to an earlier value still re-emits. So:

- Identifying the same wallet twice with the **same** DID and the **same**
  properties is deduped (no spam on re-render). Key order doesn't matter - an
  equal object is an equal key.
- A wallet that was already identified anonymously (e.g. on connect) **re-emits**
  once the Privy DID is attached after login.
- Switching Privy users on the same wallet re-emits under the new DID.
- **Linking _or unlinking_ a profile account re-emits.** Linking e.g. a Google
  account adds a `google` property shared by every wallet, so each linked wallet
  re-emits with the updated profile; unlinking it removes the property again and
  re-emits, rather than being suppressed as a state already seen this session.
- **Linking or unlinking a _wallet_ does not re-emit the others.** A new wallet
  is a new address, so it emits on its own; the existing wallets' properties are
  unchanged, so they dedupe.

The first point is what makes [account
linking](https://docs.privy.io/user-management/users/linking-accounts) work end
to end: `user` is reactive, so an effect keyed on it re-runs after every
`link*`/`unlink*` call and the new profile propagates to all of the user's
wallets.

**Volume:** because profile properties are shared across wallets, one
profile-linking action re-emits one identify **per linked wallet**. An 8-wallet
user linking a social account produces 8 identify events. That's the cost of
keeping every clustered wallet's profile current; it's bounded by (wallets ×
profile link actions per session), not by render count.

`unlinkWallet` emits no event of its own for the *removed* wallet - links are
additive server-side. See [Limitations](#limitations--roadmap).

## Advanced: `parsePrivyProperties`

The Privy identify is built on `parsePrivyProperties`, which is exported
for advanced or custom flows. It parses a Privy user into a flat properties
object and the list of linked wallets, without emitting anything:

```ts
import { parsePrivyProperties } from "@formo/analytics";

const { properties, wallets } = parsePrivyProperties(user);
// properties: { privyDid, email, twitter, github, … }
// wallets:    [{ address, walletClient, chainType, isEmbedded }, …]
```

> [!WARNING]
> **Don't loop `identify()` over `wallets` yourself.** The public `identify()`
> always promotes the wallet it is given to the SDK's current address, so a loop
> hands attribution to whichever wallet happens to be last - typically not the
> one the user is connected with. Suppressing that is exactly what the internal
> `setActive` flag does, and it is not part of the public API. If you need every
> linked wallet clustered, call `identify(user)` (optionally with
> `activeAddress`) and let it place attribution:
>
> ```ts
> await formo.identify(user, { activeAddress });
> ```

Use `parsePrivyProperties` for reading a Privy user - populating your own UI,
deriving traits, counting linked wallets - rather than as a way to emit
identifies by hand.

## Limitations & roadmap

The helper is deliberately scoped to **wallet-keyed identity clustering**. Two
related product concerns are out of scope for it today:

- **Walletless users.** `identify()` is keyed on a wallet address, so a Privy
  user with no linked wallet is a no-op (logged, not emitted). Pre-wallet
  account-creation flows and purely social logins therefore won't appear as
  users until they have a wallet. Surfacing account identity independent of a
  wallet needs a userId-keyed identify on the ingest side - a separate,
  backend-coordinated change.
- **Unlink is additive.** `identify(user)` emits positive
  wallet↔user link events only. When a wallet is unlinked in Privy your effect
  re-runs for the smaller set, but there is no SDK-level "unlink" event, so from
  the backend's perspective links only accumulate. Modeling removal needs an
  explicit unlink event and server-side handling.

Both are natural next steps for a users/clustering product surface, not part of
the identify one-liner.

## Design notes

Internals, for anyone changing this code. Skip if you are just integrating.

### What one call does

The internal `identifyPrivyUser` (`src/privy/utils.ts`) runs five steps in order:

1. **Bail if tracking is suppressed** (opt-out, excluded host/path/timezone).
   This has to come first, because step 4 mutates chain state before anything is
   emitted, so a suppressed visitor could otherwise have their chain id cleared
   with no identify to show for it.
2. **Parse `user.linkedAccounts`** into shared profile properties and wallets.
3. **Resolve the one active wallet.**
4. **Reconcile the chain** with that wallet's namespace, before emitting.
5. **Emit one identify per wallet**, all tagged `userId: user.id`, with
   `setActive: wallet === activeWallet`.

### The `setActive` flag

The concrete `identify()` implementation carries an internal `setActive` flag
that is deliberately *not* on the public `IFormoAnalytics.identify` overloads.
`setActive: false` emits the event and marks dedup, but does not touch
`currentAddress`, `currentUserId`, or the user-id cookie. That is what makes
ordering irrelevant: there is no snapshot/restore, and clustering identifies
cannot repoint attribution.

`EventFactory.create()` used to overwrite an identify's payload `user_id` with
the active-session user id. That stripped the DID from every `setActive: false`
event, silently breaking clustering for exactly the wallets this feature exists
to link. Identify events now keep their own `user_id` and skip address backfill.

### Dedup key

`(address, rdns, userId, hash(properties))`, percent-encoded and comma-joined in
a size-bounded cookie. Shapes are fixed by component count (1 `address`,
2 `address:rdns`, 3 `+userId`, 4 `+hash`) so they cannot collide, and shapes 1
and 2 are byte-identical to pre-`userId` keys, so sessions already in browsers
still match.

Writing a key **supersedes** that identity's previous entry rather than
appending. Without that, a profile reverting to an earlier value (link then
unlink) would match the stale key and emit nothing, and every profile change
would grow the cookie by one entry per wallet.

The fingerprint mirrors `JSON.stringify` semantics so it tracks what is actually
sent: `undefined`/function/symbol properties are omitted, `NaN`/`Infinity`
become `null`, `toJSON()` is honored, `Map`/`Set` serialize as `{}`. Payloads
that serialize identically must fingerprint identically, or dedup emits a
byte-identical duplicate. It is also total and never throws: `BigInt` and
circular references get distinct markers, and a throwing getter degrades to
pre-fingerprint dedup. This matters because it runs *after* active state is
mutated, so a throw would leave mutated identity with no emitted event.

The cookie budget is measured on the **encoded** value. Components are
percent-encoded when built and `CookieStorage` encodes the joined value again,
so 37 realistic DID-bearing keys measure 3500 raw but 3956 encoded, which with
the cookie name and attributes clears the ~4KB limit and makes the browser
reject the write outright.

> This dedup behaviour is global, not Privy-scoped: any `identify()` passing
> changed properties re-emits. A caller passing a volatile value (a timestamp, a
> random id) will emit one identify per call instead of one per session.

### Chain reconciliation

Privy omits `chainType` on `smart_wallet` and `cross_app` entries, so the EVM
namespace is inferred from a `0x` address shape when it is absent. Only
`"solana"` and `"ethereum"` are treated as known, so an unrecognized or future
namespace leaves the chain id alone rather than guessing. On a real mismatch the
chain id is cleared rather than asserted, since `chainType` cannot tell us the
specific chain; a real connect sets it correctly.

### Verified end to end

Against a live Privy app and a real Formo project, with a 3-wallet user:

- one identify per wallet, `HTTP 202`, all sharing the DID and one
  `anonymous_id`;
- the persisted active-wallet cookie held the wagmi-active wallet, not either of
  the other two;
- linking X and then Discord produced exactly one re-emit per wallet each time,
  with properties accumulating. Without the properties fingerprint both waves
  would have been suppressed, since `(address, userId)` never changed;
- `identities` resolved the DID to those 3 addresses across 4 `anonymous_id`s,
  `identity_links` carried anon-to-address edges predating the DID, and
  `user_profiles_mv` showed all 3 addresses carrying the DID plus both socials.

### Non-goals

- **Auto-detecting Privy with zero integrator code.** The full `user` object
  lives in Privy's React context; the SDK cannot observe it from outside, and the
  persisted tokens carry only the DID, not the wallet list.
- **An `alias()` API.** The shared-`userId` model already merges wallets
  server-side.

## The Privy user object

The integration reads the standard Privy user object returned by
[`usePrivy()`](https://docs.privy.io/guide/react/users/object). The linked
wallet addresses come from `user.linkedAccounts`, which **is fully available on
the frontend** - no server call required. Each wallet entry looks like:

```ts
{
  type: "wallet",            // or "smart_wallet"
  address: "0x…",
  walletClientType: "privy", // "privy" ⇒ embedded wallet
  chainType: "ethereum",     // or "solana"
  connectorType: "embedded",
}
```

`useWallets()` (from `@privy-io/react-auth`) returns only the **currently
connected** wallets, with the active wallet first (`wallets[0]`). That's why the
SDK can't determine the active wallet on its own from `user` alone, and why you
pass `activeAddress` in.

References:
- [The user object](https://docs.privy.io/guide/react/users/object)
- [Handling multiple wallets](https://docs.privy.io/guide/frontend/wallets/multiwallet)
- [Linking additional accounts](https://docs.privy.io/guide/react/users/linking)

## FAQ

**Do I need an `alias()` call to merge wallets?**
No. Because every wallet is identified with the same `userId`, Formo merges them
server-side. There's no separate alias step.

**What about wallets the user links later?**
Because you call `identify(user)` from an effect keyed on
`user`, it re-runs whenever the linked-wallet set changes, so newly linked
wallets are identified automatically.

**Does this work for Solana wallets?**
Yes. Solana wallets appear in `linkedAccounts` with `chainType: "solana"` and
are identified the same way; the `chain_type` property is forwarded so you can
segment by chain.

**Can I add my own properties?**
Yes - pass `options.properties` and they're merged into every identify call.
