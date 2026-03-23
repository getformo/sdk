import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { setCookieScope, getCookieScope, getIdentityCookieDomain } from "../../../src/storage/cookiePolicy";
import * as domainUtils from "../../../src/utils/domain";

describe("cookiePolicy", () => {
  let getApexDomainStub: sinon.SinonStub;

  beforeEach(() => {
    getApexDomainStub = sinon.stub(domainUtils, "getApexDomain");
    // Reset to default
    setCookieScope("host");
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("setCookieScope / getCookieScope", () => {
    it("should default to 'host'", () => {
      expect(getCookieScope()).to.equal("host");
    });

    it("should accept 'apex'", () => {
      setCookieScope("apex");
      expect(getCookieScope()).to.equal("apex");
    });

    it("should accept 'host'", () => {
      setCookieScope("apex");
      setCookieScope("host");
      expect(getCookieScope()).to.equal("host");
    });
  });

  describe("getIdentityCookieDomain", () => {
    it("should return empty string when scope is 'host'", () => {
      setCookieScope("host");
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain()).to.equal("");
    });

    it("should return apex domain when scope is 'apex' and domain is available", () => {
      setCookieScope("apex");
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain()).to.equal(".example.com");
    });

    it("should return empty string when scope is 'apex' but on localhost", () => {
      setCookieScope("apex");
      getApexDomainStub.returns(null);
      expect(getIdentityCookieDomain()).to.equal("");
    });

    it("should return empty string when scope is 'apex' but on IP address", () => {
      setCookieScope("apex");
      getApexDomainStub.returns(null);
      expect(getIdentityCookieDomain()).to.equal("");
    });
  });
});
