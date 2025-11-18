/**
 * Provider detection utilities for identifying wallet providers
 */

import { EIP1193Provider } from "../../types";

/**
 * Default icon for providers without custom icons
 */
export const DEFAULT_PROVIDER_ICON =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjRkZGIi8+CjxwYXRoIGQ9Ik0xNiA4TDggMjRoMTZMMTYgOHoiIGZpbGw9IiMzMzMiLz4KPC9zdmc+Cg==" as const;

/**
 * Common wallet provider flags used for detection
 */
export interface WalletProviderFlags {
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isWalletConnect?: boolean;
  isTrust?: boolean;
  isBraveWallet?: boolean;
  isPhantom?: boolean;
}

/**
 * Provider information returned by detection
 */
export interface ProviderInfo {
  name: string;
  rdns: string;
  uuid: string;
  icon: `data:image/${string}`;
}

/**
 * Known wallet providers with their identifying flags and metadata
 */
const KNOWN_PROVIDERS = [
  {
    flag: 'isMetaMask' as const,
    name: 'MetaMask',
    rdns: 'io.metamask',
  },
  {
    flag: 'isCoinbaseWallet' as const,
    name: 'Coinbase Wallet',
    rdns: 'com.coinbase.wallet',
  },
  {
    flag: 'isWalletConnect' as const,
    name: 'WalletConnect',
    rdns: 'com.walletconnect',
  },
  {
    flag: 'isTrust' as const,
    name: 'Trust Wallet',
    rdns: 'com.trustwallet',
  },
  {
    flag: 'isBraveWallet' as const,
    name: 'Brave Wallet',
    rdns: 'com.brave.wallet',
  },
  {
    flag: 'isPhantom' as const,
    name: 'Phantom',
    rdns: 'app.phantom',
  },
] as const;

/**
 * Attempts to detect information about an injected provider by examining
 * common wallet-specific flags and properties.
 * 
 * @param provider The injected provider to analyze
 * @returns Provider information with fallback values if detection fails
 * 
 * @example
 * ```typescript
 * const provider = window.ethereum;
 * const info = detectInjectedProviderInfo(provider);
 * console.log(info.name); // "MetaMask" or "Injected Provider"
 * ```
 */
export function detectInjectedProviderInfo(
  provider: EIP1193Provider
): ProviderInfo {
  // Default values for unknown providers
  let name = "Injected Provider";
  let rdns = "io.injected.provider";

  // Cast to check for wallet-specific flags
  const flags = provider as WalletProviderFlags;

  // Check known providers in order of precedence
  for (const knownProvider of KNOWN_PROVIDERS) {
    if (flags[knownProvider.flag]) {
      name = knownProvider.name;
      rdns = knownProvider.rdns;
      break;
    }
  }

  return {
    name,
    rdns,
    uuid: `injected-${rdns.replace(/[^a-zA-Z0-9]/g, "-")}`,
    icon: DEFAULT_PROVIDER_ICON,
  };
}

/**
 * Validates that a provider implements the required EIP-1193 interface
 * 
 * @param provider The provider to validate
 * @returns true if the provider has all required methods
 * 
 * @example
 * ```typescript
 * if (isValidProvider(window.ethereum)) {
 *   // Safe to use provider
 * }
 * ```
 */
export function isValidProvider(provider: EIP1193Provider | undefined | null): provider is EIP1193Provider {
  return (
    !!provider &&
    typeof provider.request === "function" &&
    typeof provider.on === "function" &&
    typeof provider.removeListener === "function"
  );
}

