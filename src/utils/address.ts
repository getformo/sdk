import { Address } from "../types";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { utf8ToBytes } from "ethereum-cryptography/utils.js";
import {
  ensureIfUint8Array,
  isAddress,
  uint8ArrayToHexString,
} from "../validators";
import { isNullish } from "../validators/object";

/**
 * Validates if an address is valid and non-empty
 * @param address The address to validate
 * @returns true if the address is valid and non-empty, false otherwise
 */
export const isValidAddress = (address: Address | null | undefined): address is string => {
  return typeof address === "string" && address.trim() !== "" && isAddress(address.trim());
};

/**
 * Validates and returns a trimmed valid address
 * @param address The address to validate and trim
 * @returns The trimmed address if valid, null otherwise
 */
export const getValidAddress = (address: Address | null | undefined): string | null => {
  if (typeof address === "string" && address.trim() !== "" && isAddress(address.trim())) {
    return address.trim();
  }
  return null;
};

export const toChecksumAddress = (address: Address): string => {
  if (!isAddress(address, false)) {
    throw new Error("Invalid address " + address);
  }

  const lowerCaseAddress = address.toLowerCase().replace(/^0x/i, "");

  const hash = uint8ArrayToHexString(
    keccak256(ensureIfUint8Array(utf8ToBytes(lowerCaseAddress)))
  );

  if (
    isNullish(hash) ||
    hash ===
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  )
    return ""; // // EIP-1052 if hash is equal to c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470, keccak was given empty data

  let checksumAddress = "0x";

  const addressHash = hash.replace(/^0x/i, "");

  for (let i = 0; i < lowerCaseAddress.length; i += 1) {
    // If ith character is 8 to f then make it uppercase
    if (parseInt(addressHash[i], 16) > 7) {
      checksumAddress += lowerCaseAddress[i].toUpperCase();
    } else {
      checksumAddress += lowerCaseAddress[i];
    }
  }

  return checksumAddress;
};
