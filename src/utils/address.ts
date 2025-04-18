import { Address } from "../types";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { utf8ToBytes } from "ethereum-cryptography/utils.js";
import {
  ensureIfUint8Array,
  isAddress,
  uint8ArrayToHexString,
} from "../validators";
import { isNullish } from "../validators/object";

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
