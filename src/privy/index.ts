/**
 * Privy integration module
 *
 * Provides utilities for enriching wallet profiles with Privy user data.
 * This module exports the property extraction utility and related types.
 */

export { extractPrivyProperties, getPrivyWalletAddresses } from "./utils";
export type {
  PrivyUser,
  PrivyLinkedAccount,
  PrivyAccountType,
  PrivyProfileProperties,
  PrivyWalletInfo,
} from "./types";
