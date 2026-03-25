import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { getIdentityCookieDomain } from "../../../src/storage/cookiePolicy";
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
});
