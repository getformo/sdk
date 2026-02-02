/**
 * Utility functions for Wagmi event handling
 *
 * Provides ABI encoding utilities for extracting transaction data from
 * writeContract mutations without requiring viem as a direct dependency.
 */

import { logger } from "../logger";

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

        // Convert BigInt to string for JSON serialization
        if (typeof argValue === "bigint") {
          result[argName] = argValue.toString();
        } else if (
          Array.isArray(argValue) &&
          argValue.some((v) => typeof v === "bigint")
        ) {
          // Handle arrays containing BigInt
          result[argName] = argValue.map((v) =>
            typeof v === "bigint" ? v.toString() : v
          );
        } else {
          result[argName] = argValue;
        }
      }
    });

    return result;
  } catch (error) {
    logger.warn("WagmiEventHandler: Failed to extract function args", error);
    return undefined;
  }
}
