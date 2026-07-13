/**
 * Privy integration module
 *
 * Provides utilities for enriching wallet profiles with Privy user data.
 * This module exports the property extraction utility, the one-liner
 * `identifyPrivyUser` helper, and related types.
 *
 * Note: the React binding (`useIdentifyPrivyUser`) is intentionally NOT
 * re-exported here so this module stays free of a React dependency and can be
 * used from the React-free `core` entry. Import the hook from the package root.
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
