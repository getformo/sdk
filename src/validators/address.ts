import { isUint8Array, uint8ArrayToHexString } from "./uint8array";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { utf8ToBytes } from "ethereum-cryptography/utils.js";
import { ValidInputTypes } from "../types";
import { isHexStrict } from "./string";

export const isAddress = (value: ValidInputTypes, checksum = true) => {
  if (typeof value !== "string" && !isUint8Array(value)) {
    return false;
  }

  let valueToCheck: string;

  if (isUint8Array(value)) {
    valueToCheck = uint8ArrayToHexString(value);
  } else if (typeof value === "string" && !isHexStrict(value)) {
    valueToCheck = value.toLowerCase().startsWith("0x") ? value : `0x${value}`;
  } else {
    valueToCheck = value;
  }

  // check if it has the basic requirements of an address
  if (!/^(0x)?[0-9a-f]{40}$/i.test(valueToCheck)) {
    return false;
  }
  // If it's ALL lowercase or ALL upppercase
  if (
    /^(0x|0X)?[0-9a-f]{40}$/.test(valueToCheck) ||
    /^(0x|0X)?[0-9A-F]{40}$/.test(valueToCheck)
  ) {
    return true;
    // Otherwise check each case
  }
  return checksum ? checkAddressChecksum(valueToCheck) : true;
};

export const checkAddressChecksum = (data: string): boolean => {
  if (!/^(0x)?[0-9a-f]{40}$/i.test(data)) return false;
  const address = data.slice(2);
  const updatedData = utf8ToBytes(address.toLowerCase());

  const addressHash = uint8ArrayToHexString(
    keccak256(ensureIfUint8Array(updatedData))
  ).slice(2);

  for (let i = 0; i < 40; i += 1) {
    // the nth letter should be uppercase if the nth digit of casemap is 1
    if (
      (parseInt(addressHash[i], 16) > 7 &&
        address[i].toUpperCase() !== address[i]) ||
      (parseInt(addressHash[i], 16) <= 7 &&
        address[i].toLowerCase() !== address[i])
    ) {
      return false;
    }
  }
  return true;
};

export function ensureIfUint8Array<T = any>(data: T) {
  if (
    !(data instanceof Uint8Array) &&
    (data as { constructor: { name: string } })?.constructor?.name ===
      "Uint8Array"
  ) {
    return Uint8Array.from(data as unknown as Uint8Array);
  }
  return data;
}
