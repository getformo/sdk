/**
 * The subset of the Wallet Standard this SDK reads.
 *
 * Duck-typed on purpose: the SDK must not depend on `@wallet-standard/*`
 * packages (see the dependency policy), and a wallet is discovered through
 * window events, so nothing here is ever imported from a wallet library.
 * Every field is what a conforming wallet exposes; the shapes are looser
 * than the reference types so a slightly off wallet is skipped, not thrown
 * on.
 *
 * @see https://github.com/wallet-standard/wallet-standard
 */

/** `namespace:reference`, e.g. `solana:mainnet` or `solana:devnet`. */
export type WalletStandardChain = string;

export interface WalletStandardAccount {
  readonly address: string;
  readonly publicKey?: unknown;
  /** Chains this account can sign for. Absent on a non-conforming wallet. */
  readonly chains?: readonly WalletStandardChain[];
  readonly features?: readonly string[];
  readonly label?: string;
  readonly icon?: string;
}

export interface WalletStandardWallet {
  readonly version?: string;
  readonly name: string;
  readonly icon?: string;
  /** Every chain the wallet supports, NOT the one currently selected. */
  readonly chains: readonly WalletStandardChain[];
  readonly features: Readonly<Record<string, unknown>>;
  /** Accounts the app is currently authorized for; empty until connected. */
  readonly accounts: readonly WalletStandardAccount[];
}

/** What a `standard:events` `change` event carries: only what changed. */
export interface WalletStandardChangeProperties {
  readonly chains?: readonly WalletStandardChain[];
  readonly features?: Readonly<Record<string, unknown>>;
  readonly accounts?: readonly WalletStandardAccount[];
}

/** The `standard:events` feature. */
export interface WalletStandardEventsFeature {
  readonly version?: string;
  on(
    event: "change",
    listener: (properties: WalletStandardChangeProperties) => void
  ): () => void;
}

/** The API an app hands to wallets so they can announce themselves. */
export interface WalletStandardRegisterApi {
  register(...wallets: WalletStandardWallet[]): () => void;
}

/** Dispatched by the app on `window`; `detail` is the register API. */
export const WALLET_STANDARD_APP_READY_EVENT = "wallet-standard:app-ready";

/** Dispatched by a wallet on `window`; `detail` is a callback taking the API. */
export const WALLET_STANDARD_REGISTER_WALLET_EVENT =
  "wallet-standard:register-wallet";

export const WALLET_STANDARD_EVENTS_FEATURE = "standard:events";
