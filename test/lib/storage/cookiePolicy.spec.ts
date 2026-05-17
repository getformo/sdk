import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import {
  getIdentityCookieDomain,
  getIdentityCookieSecurity,
} from "../../../src/storage/cookiePolicy";
import * as domainUtils from "../../../src/utils/domain";

describe("cookiePolicy", () => {
  let getApexDomainStub: sinon.SinonStub;

  beforeEach(() => {
    getApexDomainStub = sinon.stub(domainUtils, "getApexDomain");
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("getIdentityCookieDomain", () => {
    it("should default to cross-subdomain and return apex domain", () => {
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain()).to.equal(".example.com");
    });

    it("should return empty string when crossSubdomainCookies is false", () => {
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain(false)).to.equal("");
    });

    it("should return apex domain when crossSubdomainCookies is true and domain is available", () => {
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain(true)).to.equal(".example.com");
    });

    it("should return empty string when crossSubdomainCookies is true but on localhost", () => {
      getApexDomainStub.returns(null);
      expect(getIdentityCookieDomain(true)).to.equal("");
    });

    it("should return empty string when crossSubdomainCookies is true but on IP address", () => {
      getApexDomainStub.returns(null);
      expect(getIdentityCookieDomain(true)).to.equal("");
    });
  });

  describe("getIdentityCookieSecurity", () => {
    const origWindow = (global as any).window;
    afterEach(() => {
      (global as any).window = origWindow;
    });
    const setProtocol = (protocol?: string) => {
      if (protocol === undefined) {
        delete (global as any).window;
      } else {
        (global as any).window = { location: { protocol } };
      }
    };

    it("always sets SameSite=Lax", () => {
      setProtocol("https:");
      expect(getIdentityCookieSecurity().sameSite).to.equal("lax");
      setProtocol("http:");
      expect(getIdentityCookieSecurity().sameSite).to.equal("lax");
    });

    it("sets Secure only on HTTPS", () => {
      setProtocol("https:");
      expect(getIdentityCookieSecurity().secure).to.equal(true);
    });

    it("does NOT set Secure on http (e.g. localhost dev)", () => {
      setProtocol("http:");
      expect(getIdentityCookieSecurity().secure).to.equal(false);
    });

    it("does NOT set Secure when there is no window (SSR)", () => {
      setProtocol(undefined);
      const out = getIdentityCookieSecurity();
      expect(out).to.deep.equal({ sameSite: "lax", secure: false });
    });
  });
});
