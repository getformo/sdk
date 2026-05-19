export interface FetchRetryError extends Error {
  response?: Response;
}

type RetryOptions = {
  retries?: number;
  retryDelay?: (attempt: number) => number;
  retryOn?: (attempt: number, error: FetchRetryError | null, response: Response | null) => boolean;
};

async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit & RetryOptions
): Promise<Response> {
  const { retries = 0, retryDelay, retryOn, ...fetchInit } = init || {};

  for (let attempt = 0; attempt <= retries; attempt++) {
    const isLastAttempt = attempt === retries;

    try {
      // Resolve fetch at call time (not module load) so it can be stubbed in tests
      const response = await globalThis.fetch(input, fetchInit);

      if (response.ok) {
        return response;
      }

      // On the last attempt, return whatever we got
      if (isLastAttempt) {
        return response;
      }

      // Create an error with the response attached for retryOn check
      const responseError: FetchRetryError = new Error(response.statusText);
      responseError.response = response;

      // Check if we should retry on this response
      if (retryOn?.(attempt, responseError, response)) {
        if (retryDelay) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
        }
        // Re-check after the backoff delay. retryOn is a caller-supplied
        // gate that can change its mind during the wait (e.g. tracking
        // consent withdrawn mid-backoff). Without this re-check, an
        // opt-out during the multi-second delay would still let the next
        // attempt fire — a post-opt-out send.
        if (retryOn?.(attempt, responseError, response) === false) {
          return response;
        }
        continue;
      }

      return response;
    } catch (error) {
      // On the last attempt, throw immediately
      if (isLastAttempt) {
        throw error;
      }

      // Check if we should retry on this error
      if (retryOn?.(attempt, error as FetchRetryError, null)) {
        if (retryDelay) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
        }
        // Re-check after the backoff delay (see the response path above):
        // the caller's gate may have flipped during the wait.
        if (retryOn?.(attempt, error as FetchRetryError, null) === false) {
          throw error;
        }
        continue;
      }

      throw error;
    }
  }

  // Unreachable — the loop always returns or throws on the last attempt.
  // Required to satisfy TypeScript's control flow analysis.
  throw new Error("Unexpected: retry loop exited without returning or throwing");
}

export default fetchWithRetry;
