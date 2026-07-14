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

This is the **one-liner** replacement for hand-rolling an `identify()` loop.

## Quick start (React)

Drop `useIdentifyPrivyUser` into any component rendered under
`FormoAnalyticsProvider` and hand it the Privy `user`. It keeps Formo's identity
in sync automatically — on login, on `linkWallet`, and on `unlinkWallet`.

```tsx
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useIdentifyPrivyUser } from "@formo/analytics";

function AnalyticsIdentity() {
  const { user, authenticated, ready } = usePrivy();
  const { wallets } = useWallets();

  useIdentifyPrivyUser(user, {
    enabled: ready && authenticated,
    // The currently-connected wallet — identified last so event attribution
    // stays on the wallet the user is actually transacting with.
    activeAddress: wallets[0]?.address,
  });

  return null;
}
```

That's it. Every wallet linked to the Privy user is identified under the user's
DID, with per-wallet metadata forwarded, and event attribution pinned to the
active wallet.

> The hook is keyed on a stable signature of the DID + the set of linked wallet
> addresses (not on the `user` object reference, which Privy re-creates every
> render), so it only re-runs when something meaningful changes.

## Framework-agnostic usage

Not using React (or want to call it imperatively)? Use `identifyPrivyUser`
directly — it works with the `core` entry too.

```ts
import { identifyPrivyUser } from "@formo/analytics";

const { user } = usePrivy();
if (user) {
  await identifyPrivyUser(formo, user, {
    activeAddress: connectedWallet?.address, // optional; see "attribution" below
  });
}
```

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

`identifyPrivyUser` handles this by **ordering** the loop — it identifies the
active wallet last, so it's the one that ends up as the current address. No
special `identify()` flag is involved; the core API is unchanged.

- **When you pass `activeAddress`** (from `useWallets()` or your wagmi account),
  that wallet is moved to the end of the loop and wins attribution. The other
  linked wallets are still identified (for clustering) but earlier, so they don't
  end up as the current address.
- **When you omit it**, the helper uses a best-effort order: embedded (Privy)
  wallets first, external wallets last, attributing to the last external wallet.

Pass `activeAddress` when you can derive it for precise attribution; otherwise
the best-effort order is usually right. If you already track the connected wallet
via a separate `connect()`/wagmi flow, that remains the source of truth for
attribution once the user transacts.

## When identity re-emits

Formo deduplicates identify events per session. The dedup key now includes the
`userId`, so:

- Identifying the same wallet twice with the **same** Privy DID is deduped (no
  spam on re-render).
- A wallet that was already identified anonymously (e.g. on connect) **re-emits**
  once the Privy DID is attached after login.
- Switching Privy users on the same wallet re-emits under the new DID.

Combined with the React hook, login and `linkWallet` produce exactly the
identify events you'd expect and nothing more. `unlinkWallet` re-runs the hook
for the remaining wallets but emits no event of its own — see
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
- **Unlink is additive.** The helper emits positive wallet↔user link events
  only. When a wallet is unlinked in Privy the React hook re-runs for the
  smaller set, but there is no SDK-level "unlink" event, so from the backend's
  perspective links only accumulate. Modeling removal needs an explicit unlink
  event and server-side handling.

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
The React hook re-runs whenever the linked-wallet set changes, so newly linked
wallets are identified automatically. With the imperative helper, just call
`identifyPrivyUser` again after a `linkWallet` succeeds.

**Does this work for Solana wallets?**
Yes. Solana wallets appear in `linkedAccounts` with `chainType: "solana"` and
are identified the same way; the `chain_type` property is forwarded so you can
segment by chain.

**Can I add my own properties?**
Yes — pass `options.properties` and they're merged into every identify call.
