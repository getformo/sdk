/**
 * ERC-8021 Builder Code Extraction
 *
 * Extracts builder codes from transaction calldata by parsing the ERC-8021
 * data suffix. The suffix is appended to the end of calldata and parsed
 * backwards:
 *
 *   [original calldata] [schemaData] [schemaId (1 byte)] [ercMarker (16 bytes)]
 *
 * Schema 0 (canonical registry):
 *   [codes (variable ASCII)] [codesLength (1 byte)] [schemaId 0x00] [ercMarker]
 *
 * Schema 1 (custom registry):
 *   [registryAddress (20 bytes)] [chainId (variable)] [chainIdLength (1 byte)]
 *   [codes (variable ASCII)] [codesLength (1 byte)] [schemaId 0x01] [ercMarker]
 *
 * - ercMarker: 0x80218021802180218021802180218021 (16 bytes)
 * - codes: ASCII-encoded entity codes delimited by 0x2C (comma)
 *
 * @see https://docs.base.org/base-chain/builder-codes/builder-codes
 * @see https://www.erc8021.com/
 */

/** The 16-byte ERC-8021 marker appended at the very end of calldata */
const ERC_MARKER = "80218021802180218021802180218021";

/** Length of the ERC marker in hex characters (16 bytes = 32 hex chars) */
const ERC_MARKER_HEX_LENGTH = 32;

/** Supported schema IDs */
const SCHEMA_ID_CANONICAL = "00";
const SCHEMA_ID_CUSTOM_REGISTRY = "01";

/** Comma delimiter (0x2C) used to separate multiple codes */
const COMMA_BYTE = 0x2c;

/**
 * Decode the codes field from a hex string into a comma-separated string.
 * Validates that all bytes are printable ASCII (0x20–0x7E).
 *
 * @param codesHex - Hex string of the codes field
 * @returns Comma-separated builder codes string, or undefined if invalid
 */
function decodeCodes(codesHex: string): string | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < codesHex.length; i += 2) {
    const byte = parseInt(codesHex.slice(i, i + 2), 16);
    // Reject NaN (invalid hex), non-printable or non-ASCII bytes
    if (isNaN(byte) || byte < 0x20 || byte > 0x7e) {
      return undefined;
    }
    bytes.push(byte);
  }

  // Split on comma delimiter and decode each code as ASCII
  const codes: string[] = [];
  let current: number[] = [];

  for (const byte of bytes) {
    if (byte === COMMA_BYTE) {
      if (current.length > 0) {
        codes.push(String.fromCharCode(...current));
        current = [];
      }
    } else {
      current.push(byte);
    }
  }

  // Push the last code segment
  if (current.length > 0) {
    codes.push(String.fromCharCode(...current));
  }

  return codes.length > 0 ? codes.join(",") : undefined;
}

/**
 * Read codesLength and codes from the hex string ending at the given position.
 *
 * @param hex - Full hex string (lowercase, no 0x prefix)
 * @param endPos - Hex char position where codesLength byte ends (i.e. start of schemaId)
 * @returns Object with decoded codes string and the hex char position where codes start, or undefined
 */
function readCodes(
  hex: string,
  endPos: number
): { codes: string; codesStart: number } | undefined {
  // Read codesLength (1 byte before endPos)
  const codesLengthStart = endPos - 2;
  if (codesLengthStart < 0) {
    return undefined;
  }
  const codesLength = parseInt(hex.slice(codesLengthStart, endPos), 16);

  if (codesLength === 0 || isNaN(codesLength)) {
    return undefined;
  }

  // Read the codes field
  const codesHexLength = codesLength * 2;
  const codesStart = codesLengthStart - codesHexLength;
  if (codesStart < 0) {
    return undefined;
  }
  const codesHex = hex.slice(codesStart, codesLengthStart);

  const codes = decodeCodes(codesHex);
  if (!codes) {
    return undefined;
  }

  return { codes, codesStart };
}

/**
 * Extract builder codes from transaction calldata by parsing the ERC-8021 suffix.
 *
 * @param data - The transaction calldata hex string (with or without 0x prefix)
 * @returns A comma-separated string of builder codes (e.g. "uniswap,base"), or undefined if no valid ERC-8021 suffix is found
 */
export function extractBuilderCodes(
  data: string | undefined | null
): string | undefined {
  if (!data || typeof data !== "string") {
    return undefined;
  }

  // Normalize: remove 0x prefix and work with lowercase hex
  const hex =
    data.startsWith("0x") || data.startsWith("0X")
      ? data.slice(2).toLowerCase()
      : data.toLowerCase();

  // Minimum suffix: 1+ byte codes + 1 byte codesLength + 1 byte schemaId + 16 bytes marker = 19 bytes = 38 hex chars
  if (hex.length < 38) {
    return undefined;
  }

  // Step 1: Check last 16 bytes for ERC marker
  const markerStart = hex.length - ERC_MARKER_HEX_LENGTH;
  const marker = hex.slice(markerStart);
  if (marker !== ERC_MARKER) {
    return undefined;
  }

  // Step 2: Read schemaId (1 byte before the marker)
  const schemaIdStart = markerStart - 2;
  if (schemaIdStart < 0) {
    return undefined;
  }
  const schemaId = hex.slice(schemaIdStart, markerStart);

  // Step 3: Parse based on schemaId
  if (schemaId === SCHEMA_ID_CANONICAL || schemaId === SCHEMA_ID_CUSTOM_REGISTRY) {
    // Both Schema 0 and Schema 1 have codes in the same position
    // (immediately before schemaId when parsing backwards)
    const result = readCodes(hex, schemaIdStart);
    return result?.codes;
  }

  // Unknown schema - cannot parse
  return undefined;
}
