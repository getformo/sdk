/**
 * Generate a hash for event deduplication
 */
export async function hash(input: string): Promise<string> {
  // Simple hash function for React Native
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    h = ((h << 5) - h) + char;
    h = h & h; // Convert to 32bit integer
  }

  // Convert to hex and pad
  const hex = Math.abs(h).toString(16).padStart(8, "0");
  return hex;
}

/**
 * Generate a UUID v4
 */
export function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
