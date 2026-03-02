/**
 * ERC-8021 Builder Code Extraction
 *
 * Extracts builder codes from transaction calldata by parsing the ERC-8021
 * data suffix. The suffix is appended to the end of calldata and parsed
 * backwards:
 *
 *   [original calldata] [schemaData] [schemaId (1 byte)] [ercMarker (16 bytes)]
 *
 * - ercMarker: 0x80218021802180218021802180218021 (16 bytes)
 * - schemaId: 0x00 for the base schema
 * - schemaData (Schema 0): [codes (variable)] [codesLength (1 byte)]
 *   - codesLength: length of the codes field in bytes
 *   - codes: ASCII-encoded entity codes delimited by 0x2C (comma)
 *
 * @see https://docs.base.org/base-chain/builder-codes/builder-codes
 * @see https://www.erc8021.com/
 */

/** The 16-byte ERC-8021 marker appended at the very end of calldata */
const ERC_MARKER = "80218021802180218021802180218021";

/** Length of the ERC marker in hex characters (16 bytes = 32 hex chars) */
const ERC_MARKER_HEX_LENGTH = 32;

/** Schema ID for the base attribution schema */
const SCHEMA_ID_BASE = "00";

/** Comma delimiter (0x2C) used to separate multiple codes in Schema 0 */
const COMMA_BYTE = 0x2c;

/**
 * Extract builder code from transaction calldata by parsing the ERC-8021 suffix.
 *
 * @param data - The transaction calldata hex string (with or without 0x prefix)
 * @returns A comma-separated string of builder codes (e.g. "uniswap,base"), or undefined if no valid ERC-8021 suffix is found
 */
export function extractBuilderCode(
  data: string | undefined | null
): string | undefined {
  if (!data || typeof data !== "string") {
    return undefined;
  }

  // Normalize: remove 0x prefix and work with lowercase hex
  const hex = data.startsWith("0x") || data.startsWith("0X")
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

  // Only Schema 0 is currently supported
  if (schemaId !== SCHEMA_ID_BASE) {
    return undefined;
  }

  // Step 3: Parse Schema 0 - read codesLength (1 byte before schemaId)
  const codesLengthStart = schemaIdStart - 2;
  if (codesLengthStart < 0) {
    return undefined;
  }
  const codesLength = parseInt(hex.slice(codesLengthStart, schemaIdStart), 16);

  if (codesLength === 0 || isNaN(codesLength)) {
    return undefined;
  }

  // Step 4: Read the codes field (codesLength bytes before the codesLength byte)
  const codesHexLength = codesLength * 2;
  const codesStart = codesLengthStart - codesHexLength;
  if (codesStart < 0) {
    return undefined;
  }
  const codesHex = hex.slice(codesStart, codesLengthStart);

  // Step 5: Decode ASCII codes, splitting on comma (0x2C)
  const bytes: number[] = [];
  for (let i = 0; i < codesHex.length; i += 2) {
    const byte = parseInt(codesHex.slice(i, i + 2), 16);
    // Reject non-printable or non-ASCII bytes (allow comma 0x2C as delimiter)
    if (byte < 0x20 || byte > 0x7e) {
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
