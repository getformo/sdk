/**
 * Privy integration module
 *
 * Provides utilities for enriching wallet profiles with Privy user data.
 * This module exports the property extraction utility and related types.
 */

export { extractPrivyProperties } from "./utils";
export type {
  PrivyUser,
  PrivyLinkedAccount,
  PrivyLinkedAccountSummary,
  PrivyAccountType,
  PrivyProfileProperties,
} from "./types";
