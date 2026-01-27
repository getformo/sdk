import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import fetchWithRetry from "../../../src/fetch";

describe("fetchWithRetry", () => {
  let fetchStub: sinon.SinonStub;

  function makeResponse(status: number, statusText: string): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: new Headers(),
      redirected: false,
      type: "basic" as ResponseType,
      url: "",
      clone: () => makeResponse(status, statusText),
      body: null,
      bodyUsed: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
      formData: async () => new FormData(),
      json: async () => ({}),
      text: async () => "",
      bytes: async () => new Uint8Array(),
    } as Response;
  }

  let originalGlobalThis: typeof globalThis;

  beforeEach(() => {
    // Ensure globalThis is available (other tests may delete it from global)
    if (typeof globalThis === "undefined") {
      Object.defineProperty(global, "globalThis", {
        value: global,
        writable: true,
        configurable: true,
      });
    }
    originalGlobalThis = globalThis;
    fetchStub = sinon.stub(globalThis, "fetch");
  });

  afterEach(() => {
    sinon.restore();
    // Restore globalThis if it was removed by other tests
    if (typeof globalThis === "undefined") {
      Object.defineProperty(global, "globalThis", {
        value: originalGlobalThis,
        writable: true,
        configurable: true,
      });
    }
  });

  describe("successful requests", () => {
    it("should resolve with response on successful fetch", async () => {
      const okResponse = makeResponse(200, "OK");
      fetchStub.resolves(okResponse);

      const result = await fetchWithRetry("https://api.example.com");
      expect(result).to.equal(okResponse);
      expect(fetchStub.calledOnce).to.be.true;
    });
  });

  describe("error handling", () => {
    it("should reject on network error", async () => {
      const networkError = new TypeError("Failed to fetch");
      fetchStub.rejects(networkError);

      try {
        await fetchWithRetry("https://api.example.com");
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.equal(networkError);
      }
    });

    it("should resolve with non-ok response (not reject)", async () => {
      const serverError = makeResponse(500, "Internal Server Error");
      fetchStub.resolves(serverError);

      // fetchWithRetry returns the response even if not ok —
      // it's the caller's responsibility to check response.ok
      const result = await fetchWithRetry("https://api.example.com");
      expect(result.ok).to.be.false;
      expect(result.status).to.equal(500);
    });
  });

  describe("retry logic", () => {
    it("should retry on retryable error and eventually succeed", async () => {
      const networkError = new TypeError("Failed to fetch");
      const okResponse = makeResponse(200, "OK");

      fetchStub.onFirstCall().rejects(networkError);
      fetchStub.onSecondCall().resolves(okResponse);

      const result = await fetchWithRetry("https://api.example.com", {
        retries: 2,
        retryOn: () => true,
        retryDelay: () => 0,
      });

      expect(result).to.equal(okResponse);
      expect(fetchStub.calledTwice).to.be.true;
    });

    it("should throw after exhausting all retries on error", async () => {
      const networkError = new TypeError("Failed to fetch");
      fetchStub.rejects(networkError);

      try {
        await fetchWithRetry("https://api.example.com", {
          retries: 2,
          retryOn: () => true,
          retryDelay: () => 0,
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.equal(networkError);
      }

      // Initial attempt + 2 retries = 3 calls
      expect(fetchStub.callCount).to.equal(3);
    });

    it("should return non-ok response after exhausting retries", async () => {
      const serverError = makeResponse(500, "Internal Server Error");
      fetchStub.resolves(serverError);

      const result = await fetchWithRetry("https://api.example.com", {
        retries: 2,
        retryOn: () => true,
        retryDelay: () => 0,
      });

      expect(result.ok).to.be.false;
      expect(result.status).to.equal(500);
      expect(fetchStub.callCount).to.equal(3);
    });

    it("should not retry when retryOn returns false", async () => {
      const networkError = new TypeError("Failed to fetch");
      fetchStub.rejects(networkError);

      try {
        await fetchWithRetry("https://api.example.com", {
          retries: 3,
          retryOn: () => false,
          retryDelay: () => 0,
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.equal(networkError);
      }

      // Should not have retried
      expect(fetchStub.calledOnce).to.be.true;
    });

    it("should not retry non-ok response when retryOn returns false", async () => {
      const serverError = makeResponse(500, "Internal Server Error");
      fetchStub.resolves(serverError);

      const result = await fetchWithRetry("https://api.example.com", {
        retries: 3,
        retryOn: () => false,
        retryDelay: () => 0,
      });

      expect(result.status).to.equal(500);
      expect(fetchStub.calledOnce).to.be.true;
    });

    it("should strip retry options before passing to native fetch", async () => {
      const okResponse = makeResponse(200, "OK");
      fetchStub.resolves(okResponse);

      await fetchWithRetry("https://api.example.com", {
        method: "POST",
        retries: 3,
        retryOn: () => true,
        retryDelay: () => 0,
      });

      const passedInit = fetchStub.firstCall.args[1];
      expect(passedInit).to.have.property("method", "POST");
      expect(passedInit).to.not.have.property("retries");
      expect(passedInit).to.not.have.property("retryOn");
      expect(passedInit).to.not.have.property("retryDelay");
    });

    it("should apply retryDelay between attempts", async () => {
      const clock = sinon.useFakeTimers();
      const networkError = new TypeError("Failed to fetch");
      const okResponse = makeResponse(200, "OK");

      fetchStub.onFirstCall().rejects(networkError);
      fetchStub.onSecondCall().resolves(okResponse);

      const delays: number[] = [];
      const resultPromise = fetchWithRetry("https://api.example.com", {
        retries: 2,
        retryOn: () => true,
        retryDelay: (attempt) => {
          const delay = Math.pow(2, attempt) * 1_000;
          delays.push(delay);
          return delay;
        },
      });

      // Advance past the first retry delay (2^0 * 1000 = 1000ms)
      await clock.tickAsync(1000);

      const result = await resultPromise;
      expect(result).to.equal(okResponse);
      expect(delays).to.deep.equal([1000]);

      clock.restore();
    });
  });
});
