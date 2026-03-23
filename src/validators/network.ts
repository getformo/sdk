const objectToString = Object.prototype.toString;

const isError = (value: any) => {
  const tag = objectToString.call(value);
  return tag === "[object Error]" || tag === "[object DOMException]";
};

const errorNames = new Set(["TypeError", "TimeoutError", "NetworkError"]);

const errorMessages = new Set([
  "network error", // Chrome
  "Failed to fetch", // Chrome
  "NetworkError when attempting to fetch resource.", // Firefox
  "The Internet connection appears to be offline.", // Safari 16
  "Load failed", // Safari 17+
  "Network request failed", // `cross-fetch`
  "fetch failed", // Undici (Node.js)
  "terminated", // Undici (Node.js)
  "The operation was aborted due to timeout", // AbortSignal.timeout()
]);

export function isNetworkError(error: any) {
  const isValid =
    error &&
    isError(error) &&
    errorNames.has(error.name) &&
    typeof error.message === "string";

  if (!isValid) {
    return false;
  }

  // We do an extra check for Safari 17+ as it has a very generic error message.
  // Network errors in Safari have no stack.
  if (error.message === "Load failed") {
    return error.stack === undefined;
  }

  return errorMessages.has(error.message);
}
