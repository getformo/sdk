export function isUint8Array(data: unknown | Uint8Array): data is Uint8Array {
  return (
    data instanceof Uint8Array ||
    (data as { constructor: { name: string } })?.constructor?.name ===
      "Uint8Array" ||
    (data as { constructor: { name: string } })?.constructor?.name === "Buffer"
  );
}

export function uint8ArrayToHexString(uint8Array: Uint8Array): string {
  let hexString = "0x";
  for (const e of uint8Array as any) {
    const hex = e.toString(16);
    hexString += hex.length === 1 ? `0${hex}` : hex;
  }
  return hexString;
}
