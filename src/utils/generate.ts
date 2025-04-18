import type { UUID } from "crypto";

export async function hash(input: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  const byteArray = new Uint8Array(hashBuffer);
  return Array.from(byteArray)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function generateNativeUUID(): UUID {
  return crypto.randomUUID();
}
