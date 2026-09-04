/**
 * Solana integration module
 *
 * Wallets are discovered through the Wallet Standard and their connect /
 * disconnect events captured automatically for wallets registered with the
 * page through Wallet Standard.
 * Framework-kit apps can additionally pass their zustand store for
 * transaction lifecycle events. Signature events (signMessage /
 * signTransaction) require explicit tracking via formo.signature(), since
 * neither source reports them.
 *
 * @see https://github.com/wallet-standard/wallet-standard
 * @see https://github.com/solana-foundation/framework-kit
 */

export { SolanaStoreHandler } from "./SolanaStoreHandler";
export { SolanaWalletStandardRegistry } from "./SolanaWalletStandardRegistry";
export { SolanaManager } from "./SolanaManager";
export * from "./types";
export * from "./storeTypes";
export * from "./walletStandardTypes";
export * from "./address";
