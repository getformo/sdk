/**
 * Utility functions for Wagmi event handling
 *
 * Provides ABI encoding utilities for extracting transaction data from
 * writeContract mutations without requiring viem as a direct dependency.
 */

import { logger } from "../logger";

/**
 * Flatten a nested object into a flat object with underscore-separated keys.
 * Only leaf values (primitives) are included; intermediate objects are not.
 *
 * Example:
 *   Input: { o: { x: "100", inner: { a: "42", b: "0xRecipient" } } }
 *   Output: { o_x: "100", o_inner_a: "42", o_inner_b: "0xRecipient" }
 *
 * @param obj - The object to flatten
 * @param prefix - Optional prefix for keys (used in recursion)
 * @returns A flat object with underscore-separated keys
 */
export function flattenObject(
  obj: Record<string, unknown>,
  prefix = ""
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}_${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Recursively flatten nested objects
      const nested = flattenObject(value as Record<string, unknown>, newKey);
      Object.assign(result, nested);
    } else {
      // Leaf value (primitive or array) - add directly
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Recursively convert all BigInt values to strings for JSON serialization
 * Handles nested objects, arrays, and deeply nested structures (e.g., Solidity structs)
 *
 * @param value - The value to convert
 * @returns The value with all BigInt converted to strings
 */
export function convertBigIntToString(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(convertBigIntToString);
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = convertBigIntToString(val);
    }
    return result;
  }

  return value;
}

/**
 * ABI function item type
 */
export interface AbiItem {
  type: string;
  name?: string;
  inputs?: AbiInput[];
  outputs?: AbiOutput[];
  stateMutability?: string;
}

export interface AbiInput {
  name: string;
  type: string;
  indexed?: boolean;
  components?: AbiInput[];
  internalType?: string;
}

export interface AbiOutput {
  name: string;
  type: string;
  components?: AbiOutput[];
  internalType?: string;
}

/**
 * Type for viem's encodeFunctionData function
 */
type EncodeFunctionDataFn = (params: {
  abi: AbiItem[];
  functionName: string;
  args?: unknown[];
}) => string;

// Cached viem module reference
let viemModule: { encodeFunctionData: EncodeFunctionDataFn } | null | undefined;

/**
 * Try to load viem synchronously via require
 * Returns null if viem is not available
 */
function tryLoadViem(): { encodeFunctionData: EncodeFunctionDataFn } | null {
  if (viemModule !== undefined) {
    return viemModule;
  }

  try {
    // Use require to load viem synchronously
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const viem = require("viem");
    if (viem?.encodeFunctionData) {
      viemModule = {
        encodeFunctionData: viem.encodeFunctionData as EncodeFunctionDataFn,
      };
      return viemModule;
    }
  } catch {
    // viem is not available
  }

  viemModule = null;
  return null;
}

/**
 * Encode writeContract data using viem's encodeFunctionData
 *
 * @param abi - The contract ABI
 * @param functionName - The function name to encode
 * @param args - The function arguments
 * @returns The encoded calldata or undefined if encoding fails
 */
export function encodeWriteContractData(
  abi: AbiItem[],
  functionName: string,
  args?: unknown[]
): string | undefined {
  try {
    const viem = tryLoadViem();
    if (!viem) {
      logger.debug(
        "WagmiEventHandler: viem not available, cannot encode function data"
      );
      return undefined;
    }

    const data = viem.encodeFunctionData({
      abi,
      functionName,
      args: args || [],
    });

    return data;
  } catch (error) {
    logger.warn("WagmiEventHandler: Failed to encode function data", error);
    return undefined;
  }
}

/**
 * Extract function arguments as a name-value map from ABI and args array
 *
 * @param abi - The contract ABI
 * @param functionName - The function name
 * @param args - The function arguments array
 * @returns A map of argument names to values, or undefined if extraction fails
 */
export function extractFunctionArgs(
  abi: AbiItem[],
  functionName: string,
  args?: unknown[]
): Record<string, unknown> | undefined {
  if (!abi || !functionName || !args || !Array.isArray(args)) {
    return undefined;
  }

  try {
    // Find the function in the ABI
    const abiItem = abi.find(
      (item) => item.type === "function" && item.name === functionName
    );

    if (!abiItem?.inputs || !Array.isArray(abiItem.inputs)) {
      return undefined;
    }

    const result: Record<string, unknown> = {};

    abiItem.inputs.forEach((input, index) => {
      if (index < args.length) {
        const argValue = args[index];
        const argName = input.name || `arg${index}`;

        // Recursively convert BigInt to string for JSON serialization
        // Handles: direct BigInt, arrays with BigInt, nested objects/structs with BigInt
        result[argName] = convertBigIntToString(argValue);
      }
    });

    return result;
  } catch (error) {
    logger.warn("WagmiEventHandler: Failed to extract function args", error);
    return undefined;
  }
}
