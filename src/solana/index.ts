/**
 * Solana integration module
 *
 * Provides integration with Solana wallets for wallet event tracking.
 * Supports two modes:
 *
 * 1. **Store mode** (recommended): Automatic event capture via framework-kit's zustand store
 * 2. **Explicit tracking**: Manual tracking methods for any wallet standard
 *
 * @see https://github.com/solana-foundation/framework-kit
 * @see https://github.com/anza-xyz/wallet-adapter
 */

export { SolanaAdapter } from "./SolanaAdapter";
export { SolanaStoreHandler } from "./SolanaStoreHandler";
export { SolanaManager } from "./SolanaManager";
export * from "./types";
export * from "./storeTypes";
export * from "./address";
