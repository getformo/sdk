/**
 * Privy integration module
 *
 * Provides utilities for enriching wallet profiles with Privy user data:
 * `parsePrivyProperties` (low-level parsing) and `identifyPrivyUser` (identify
 * every linked wallet under the user's DID). The same behavior is also
 * available as `formo.identify(user, { privy: true })`.
 *
 * This module is React-free so it can be used from the `core` entry.
 */

export { parsePrivyProperties, identifyPrivyUser } from "./utils";
export type { IdentifyPrivyUserOptions } from "./utils";
export type {
  PrivyUser,
  PrivyLinkedAccount,
  PrivyAccountType,
  PrivyProfileProperties,
  PrivyWalletInfo,
} from "./types";
