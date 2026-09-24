export type ReplayEncoding = "gzip-base64" | "json";

/** Whether this browser can gzip in-page (every evergreen browser since 2023). */
export function canCompress(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof btoa === "function"
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  // String.fromCharCode over the whole array overflows the call stack on
  // large snapshots, so convert in slices.
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(
      null,
      Array.prototype.slice.call(bytes, i, i + step) as number[]
    );
  }
  return btoa(binary);
}

/**
 * Encode serialized rrweb events for transport. Falls back to plain JSON
 * when the browser cannot compress, or when compression fails.
 */
export async function encodeReplayData(
  json: string
): Promise<{ encoding: ReplayEncoding; data: string }> {
  if (!canCompress()) return { encoding: "json", data: json };
  try {
    const stream = new Blob([json])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return {
      encoding: "gzip-base64",
      data: bytesToBase64(new Uint8Array(buffer)),
    };
  } catch {
    return { encoding: "json", data: json };
  }
}
