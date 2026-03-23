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
    it("should default to 'host' and return empty string", () => {
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain()).to.equal("");
    });

    it("should return empty string when scope is 'host'", () => {
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain("host")).to.equal("");
    });

    it("should return apex domain when scope is 'apex' and domain is available", () => {
      getApexDomainStub.returns("example.com");
      expect(getIdentityCookieDomain("apex")).to.equal(".example.com");
    });

    it("should return empty string when scope is 'apex' but on localhost", () => {
      getApexDomainStub.returns(null);
      expect(getIdentityCookieDomain("apex")).to.equal("");
    });

    it("should return empty string when scope is 'apex' but on IP address", () => {
      getApexDomainStub.returns(null);
      expect(getIdentityCookieDomain("apex")).to.equal("");
    });
  });
});
