/**
 * Parses a chainId string (hex or decimal) to a number.
 * @param chainId - The chainId as a string (e.g., '0x1', '1')
 * @returns The chainId as a number
 */
export function parseChainId(chainId: string): number {
  if (typeof chainId !== 'string') return 0;
  if (chainId.startsWith('0x') || chainId.startsWith('0X')) {
    return parseInt(chainId, 16);
  }
  return parseInt(chainId, 10);
} 