/**
 * Privy integration module
 *
 * Exports `parsePrivyProperties`, which parses a Privy user into a flat
 * properties object and the list of linked wallets without emitting anything -
 * useful for inspecting or displaying what an identify would send.
 *
 * The identify itself is `formo.identify(user)`, which recognises a Privy user
 * by shape. The function behind it lives in ./utils and is internal.
 *
 * This module is React-free so it can be used from the `core` entry.
 */

export { parsePrivyProperties } from "./utils";
export type {
  PrivyUser,
  PrivyLinkedAccount,
  PrivyAccountType,
  PrivyProfileProperties,
  PrivyWalletInfo,
} from "./types";
