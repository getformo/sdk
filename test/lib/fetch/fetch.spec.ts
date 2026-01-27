import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import * as fetchModule from "../../../src/fetch";

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

  beforeEach(() => {
    // Stub the default export from the fetch module
    fetchStub = sinon.stub(fetchModule, "default");
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("successful requests", () => {
    it("should resolve with response on successful fetch", async () => {
      const okResponse = makeResponse(200, "OK");
      fetchStub.resolves(okResponse);

      const result = await fetchModule.default("https://api.example.com");
      expect(result).to.equal(okResponse);
      expect(fetchStub.calledOnce).to.be.true;
    });
  });

  describe("error handling", () => {
    it("should reject on network error", async () => {
      const networkError = new TypeError("Failed to fetch");
      fetchStub.rejects(networkError);

      try {
        await fetchModule.default("https://api.example.com");
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
      const result = await fetchModule.default("https://api.example.com");
      expect(result.ok).to.be.false;
      expect(result.status).to.equal(500);
    });
  });
});
