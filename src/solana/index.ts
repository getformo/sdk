/**
 * Solana integration module
 *
 * Provides automatic event capture for Solana wallets via framework-kit's
 * zustand store. Connect/disconnect and transaction events are tracked
 * automatically. Signature events (signMessage/signTransaction) require
 * explicit tracking via formo.solana.trackSignature() since framework-kit
 * doesn't track these in store state.
 *
 * @see https://github.com/solana-foundation/framework-kit
 */

export { SolanaStoreHandler } from "./SolanaStoreHandler";
export { SolanaManager } from "./SolanaManager";
export * from "./types";
export * from "./storeTypes";
export * from "./address";
