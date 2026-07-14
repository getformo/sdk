# Privy Integration for Formo Analytics SDK

## Overview

[Privy](https://privy.io) gives each user a single account (identified by a
Privy DID such as `did:privy:cm3np...`) that can have **many linked wallets** —
an embedded Privy wallet plus any external wallets (MetaMask, Rainbow, Coinbase,
smart wallets, Solana wallets, …) the user connects over time.

To Formo, each of those wallet addresses looks like a different user. The Privy
integration fixes that: it tags **every** linked wallet with the same Privy
`userId`, so Formo can cluster them server-side into one user. Attach a wallet
today, connect three more next week — they all roll up under the same identity.

```
                 Privy user (did:privy:abc…)
        ┌───────────────┬───────────────┬───────────────┐
   embedded 0x11…   MetaMask 0x22…  Rainbow 0x33…   Solana 9xQ…
        └───────────────┴───────────────┴───────────────┘
   identify({ address, userId: "did:privy:abc…" }) for each wallet
                              ↓
              Formo clusters them into one user
```

The whole thing is a single `identify(user, { privy: true })` call — a one-line
replacement for hand-rolling an `identify()` loop over the linked wallets.

## Quick start (React)

Pass the `usePrivy()` user to `identify()` with `{ privy: true }`. Call it from
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
      formo.identify(user, { privy: true });
    }
  }, [formo, authenticated, user]);

  return null;
}
```

That single `identify(user, { privy: true })` call identifies **every** wallet
linked to the Privy user under the user's DID, forwards each wallet's metadata,
and pins event attribution to the active wallet.

> The effect above is yours to own — key it on `user` (and `wallets`) so it
> re-runs on login and link/unlink. The SDK deduplicates the underlying identify
> events per `(wallet, user)`, so re-running on every render is safe.

## How it works

`identify(user, { privy: true })` is a thin convenience form of `identify()`:
when it sees the `{ privy: true }` flag it treats the first argument as a Privy
user and expands `user.linkedAccounts`, calling the normal
`identify({ address, userId })` once per linked wallet. The Privy-specific logic
lives in the SDK's Privy module; the core `identify()` just dispatches to it.

## Framework-agnostic usage

Not using React (or prefer an explicit function)? `identifyPrivyUser` is the
same thing without the flag, and works from the `core` entry too.

```ts
import { identifyPrivyUser } from "@formo/analytics";

const { user } = usePrivy();
if (user) {
  await identifyPrivyUser(formo, user, {
    activeAddress: connectedWallet?.address, // optional; see "attribution" below
  });
}
```

`formo.identify(user, { privy: true, activeAddress, properties })` and
`identifyPrivyUser(formo, user, { activeAddress, properties })` are equivalent —
the former is sugar over the latter.

### Signature

```ts
identifyPrivyUser(
  analytics: IFormoAnalytics,
  user: PrivyUser,
  options?: {
    activeAddress?: string;               // active/connected wallet
    properties?: IFormoEventProperties;   // merged into every identify call
  }
): Promise<void>
```

## What gets sent

For each linked wallet, `identifyPrivyUser` calls:

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

The wallets are identified in a deliberate order — the active wallet last — so
event attribution lands on it rather than an arbitrary linked wallet (see below).

The shared **profile properties** are parsed from the Privy user's linked
accounts (see [`parsePrivyProperties`](#advanced-parseprivyproperties)) and
include email, connected socials (Twitter/X, Discord, GitHub, Farcaster,
Google, …), the Privy DID, and account creation time.

The **per-wallet metadata** (`wallet_client`, `chain_type`, `is_embedded`) is
attached per-address, so you can tell an embedded wallet apart from an external
one, and an Ethereum wallet apart from a Solana one, in your analytics.
`wallet_client` and `chain_type` are omitted when Privy doesn't provide them;
`is_embedded` is always present.

> **`options.properties` are captured at first identify.** Identify events are
> deduped per `(wallet, user)` per session (see [below](#when-identity-re-emits)),
> so extra properties you pass are recorded on the first identify for each wallet
> and are **not** refreshed by later calls in the same session. Treat them as
> identity metadata set at identify time, not a live user profile. To update a
> live trait (plan, org, …), send it on your own events instead.

## Event attribution and the active wallet

A Privy user's `linkedAccounts` lists **every** wallet they've ever linked — not
which one they're using right now. Since `identify()` also updates the SDK's
"current address" (the wallet later events are attributed to), naively looping
over every linked wallet would leave attribution on whichever wallet happened to
be identified last.

The SDK handles this by **ordering** the loop — it identifies the chosen wallet
last, so it's the one that ends up as the current address. The wallet is chosen,
in order:

1. **`activeAddress`**, if you pass it (an optional override — e.g. the connected
   wallet from `useWallets()[0]?.address` or your wagmi account, which reflects
   the live active wallet most precisely);
2. else **`user.wallet`** — the primary wallet Privy surfaces on the user object,
   so `identify(user, { privy: true })` needs no argument at all;
3. else a best-effort order: embedded (Privy) wallets first, attributing to the
   last external wallet.

In practice you can just call `formo.identify(user, { privy: true })` and let it
default to Privy's primary wallet. Pass `activeAddress` only when you want to pin
attribution to a specific wallet. If you already track the connected wallet via a
separate `connect()`/wagmi flow, that remains the source of truth for attribution
once the user transacts.

## When identity re-emits

Formo deduplicates identify events per session. The dedup key now includes the
`userId`, so:

- Identifying the same wallet twice with the **same** Privy DID is deduped (no
  spam on re-render).
- A wallet that was already identified anonymously (e.g. on connect) **re-emits**
  once the Privy DID is attached after login.
- Switching Privy users on the same wallet re-emits under the new DID.

Combined with re-running your effect on `user` changes, login and `linkWallet`
produce exactly the identify events you'd expect and nothing more. `unlinkWallet`
re-runs the effect for the remaining wallets but emits no event of its own — see
[Limitations](#limitations--roadmap).

## Advanced: `parsePrivyProperties`

`identifyPrivyUser` is built on `parsePrivyProperties`, which is still exported
for advanced or custom flows. It parses a Privy user into a flat properties
object and the list of linked wallets, without emitting anything:

```ts
import { parsePrivyProperties } from "@formo/analytics";

const { properties, wallets } = parsePrivyProperties(user);
// properties: { privyDid, email, twitter, github, … }
// wallets:    [{ address, walletClient, chainType, isEmbedded }, …]

for (const wallet of wallets) {
  formo.identify(
    { address: wallet.address, userId: user.id },
    { ...properties, wallet_client: wallet.walletClient },
  );
}
```

Reach for this only if you need behavior `identifyPrivyUser` doesn't cover —
otherwise prefer the one-liner, which also handles per-wallet metadata and
active-wallet attribution.

## Limitations & roadmap

The helper is deliberately scoped to **wallet-keyed identity clustering**. Two
related product concerns are out of scope for it today:

- **Walletless users.** `identify()` is keyed on a wallet address, so a Privy
  user with no linked wallet is a no-op (logged, not emitted). Pre-wallet
  account-creation flows and purely social logins therefore won't appear as
  users until they have a wallet. Surfacing account identity independent of a
  wallet needs a userId-keyed identify on the ingest side — a separate,
  backend-coordinated change.
- **Unlink is additive.** `identify(user, { privy: true })` emits positive
  wallet↔user link events only. When a wallet is unlinked in Privy your effect
  re-runs for the smaller set, but there is no SDK-level "unlink" event, so from
  the backend's perspective links only accumulate. Modeling removal needs an
  explicit unlink event and server-side handling.

Both are natural next steps for a users/clustering product surface, not part of
the identify one-liner.

## The Privy user object

The integration reads the standard Privy user object returned by
[`usePrivy()`](https://docs.privy.io/guide/react/users/object). The linked
wallet addresses come from `user.linkedAccounts`, which **is fully available on
the frontend** — no server call required. Each wallet entry looks like:

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
Because you call `identify(user, { privy: true })` from an effect keyed on
`user`, it re-runs whenever the linked-wallet set changes, so newly linked
wallets are identified automatically.

**Does this work for Solana wallets?**
Yes. Solana wallets appear in `linkedAccounts` with `chainType: "solana"` and
are identified the same way; the `chain_type` property is forwarded so you can
segment by chain.

**Can I add my own properties?**
Yes — pass `options.properties` and they're merged into every identify call.
