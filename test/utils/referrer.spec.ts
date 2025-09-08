import { describe, it } from "mocha";
import { expect } from "chai";
import { isInternalReferrer, filterInternalReferrer } from "../../src/utils/referrer";

describe("referrer utils", () => {
  describe("isInternalReferrer", () => {
    it("should identify same domain as internal", () => {
      const referrer = "https://app.formo.so/page1";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(isInternalReferrer(referrer, currentUrl)).to.equal(true);
    });

    it("should identify subdomain as internal", () => {
      const referrer = "https://app.formo.so/page1";
      const currentUrl = "https://dashboard.formo.so/page2";
      
      expect(isInternalReferrer(referrer, currentUrl)).to.equal(true);
    });

    it("should identify different domain as external", () => {
      const referrer = "https://google.com/search";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(isInternalReferrer(referrer, currentUrl)).to.equal(false);
    });


    it("should handle case insensitive domain matching", () => {
      const referrer = "https://App.Formo.So/page1";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(isInternalReferrer(referrer, currentUrl)).to.equal(true);
    });

    it("should handle empty referrer", () => {
      const referrer = "";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(isInternalReferrer(referrer, currentUrl)).to.equal(false);
    });

    it("should handle invalid URLs", () => {
      const referrer = "not-a-url";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(isInternalReferrer(referrer, currentUrl)).to.equal(false);
    });

  });

  describe("filterInternalReferrer", () => {
    it("should return empty string for internal referrer", () => {
      const referrer = "https://app.formo.so/page1";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(filterInternalReferrer(referrer, currentUrl)).to.equal("");
    });

    it("should return referrer for external source", () => {
      const referrer = "https://google.com/search";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(filterInternalReferrer(referrer, currentUrl)).to.equal("https://google.com/search");
    });


    it("should filter internal referrers automatically", () => {
      const referrer = "https://app.formo.so/page1";
      const currentUrl = "https://app.formo.so/page2";
      
      expect(filterInternalReferrer(referrer, currentUrl)).to.equal("");
    });

    it("should preserve external referrers from social media", () => {
      const referrer = "https://twitter.com/somepost";
      const currentUrl = "https://app.formo.so/landing";
      
      expect(filterInternalReferrer(referrer, currentUrl)).to.equal("https://twitter.com/somepost");
    });

    it("should preserve external referrers from search engines", () => {
      const referrer = "https://www.google.com/search?q=formo";
      const currentUrl = "https://app.formo.so/home";
      
      expect(filterInternalReferrer(referrer, currentUrl)).to.equal("https://www.google.com/search?q=formo");
    });

    it("should filter internal subdomain but preserve external", () => {
      const internalReferrer = "https://dashboard.formo.so/analytics";
      const externalReferrer = "https://partner.example.com/link";
      const currentUrl = "https://app.formo.so/dashboard";
      
      // Internal subdomain should be filtered
      expect(filterInternalReferrer(internalReferrer, currentUrl)).to.equal("");
      
      // External domain should be preserved
      expect(filterInternalReferrer(externalReferrer, currentUrl)).to.equal("https://partner.example.com/link");
    });
  });
});
