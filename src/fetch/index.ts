export interface FetchRetryError extends Error {
  response?: Response;
}

type RetryOptions = {
  retries?: number;
  retryDelay?: (attempt: number) => number;
  retryOn?: (attempt: number, error: FetchRetryError | null, response: Response | null) => boolean;
};

type FetchWithRetry = (
  input: RequestInfo | URL,
  init?: RequestInit & RetryOptions
) => Promise<Response>;

function createFetchWithRetry(fetchFn: typeof fetch): FetchWithRetry {
  return async function fetchWithRetry(
    input: RequestInfo | URL,
    init?: RequestInit & RetryOptions
  ): Promise<Response> {
    const { retries = 0, retryDelay, retryOn, ...fetchInit } = init || {};

    let lastError: FetchRetryError | null = null;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchFn(input, fetchInit);
        lastResponse = response;

        if (response.ok) {
          return response;
        }

        // Create an error with the response attached for non-ok responses
        const responseError: FetchRetryError = new Error(response.statusText);
        responseError.response = response;

        // Check if we should retry on this response
        if (attempt < retries && retryOn?.(attempt, responseError, response)) {
          if (retryDelay) {
            await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
          }
          continue;
        }

        return response;
      } catch (error) {
        lastError = error as FetchRetryError;

        // Check if we should retry on this error
        if (attempt < retries && retryOn?.(attempt, lastError, null)) {
          if (retryDelay) {
            await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
          }
          continue;
        }

        throw error;
      }
    }

    // If we've exhausted retries and have a response, return it
    if (lastResponse) {
      return lastResponse;
    }

    // Otherwise throw the last error
    throw lastError;
  };
}

export default createFetchWithRetry(globalThis.fetch);
