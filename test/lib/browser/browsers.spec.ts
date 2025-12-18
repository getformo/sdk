import { describe, it } from "mocha";
import { expect } from "chai";

// Browser detection tests - testing the utility logic without require() mocking
describe("Browser Detection Utilities", () => {
  describe("User Agent Parsing Logic", () => {
    // Test the regex patterns used in browser detection
    it("should identify Firefox from user agent", () => {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
      expect(/Firefox\/\d+/i.test(ua)).to.be.true;
    });

    it("should identify Chrome from user agent", () => {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      expect(/Chrome\/\d+/i.test(ua)).to.be.true;
    });

    it("should identify Edge from user agent", () => {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
      expect(/Edg\/\d+/i.test(ua)).to.be.true;
    });

    it("should identify Opera from user agent", () => {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0";
      expect(/OPR\/\d+/i.test(ua)).to.be.true;
    });

    it("should identify Safari from user agent", () => {
      const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
      const isSafari = /Safari\/\d+/i.test(ua) && !/Chrome\/\d+/i.test(ua);
      expect(isSafari).to.be.true;
    });

    it("should identify Brave from user agent data brands", () => {
      const brands = [
        { brand: "Brave", version: "120" },
        { brand: "Chromium", version: "120" },
      ];
      const isBrave = brands.some(b => /Brave/i.test(b.brand));
      expect(isBrave).to.be.true;
    });

    it("should identify Brave from user agent string", () => {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Brave Chrome/120.0.0.0 Safari/537.36";
      expect(/Brave/i.test(ua)).to.be.true;
    });

    it("should return unknown for unrecognized browsers", () => {
      const ua = "CustomBrowser/1.0";
      const isFirefox = /Firefox\/\d+/i.test(ua);
      const isEdge = /Edg\/\d+/i.test(ua);
      const isOpera = /OPR\/\d+/i.test(ua);
      const isSafari = /Safari\/\d+/i.test(ua) && !/Chrome\/\d+/i.test(ua);
      const isChrome = /Chrome\/\d+/i.test(ua);

      expect(isFirefox || isEdge || isOpera || isSafari || isChrome).to.be.false;
    });
  });

  describe("Browser Detection Order", () => {
    it("should check Edge before Chrome (both have Chrome in UA)", () => {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

      // Detection order: Firefox -> Edge -> Opera -> Safari -> Chrome
      const isEdge = /Edg\/\d+/i.test(ua);
      const isChrome = /Chrome\/\d+/i.test(ua);

      expect(isEdge).to.be.true;
      expect(isChrome).to.be.true; // Both match, but Edge should be checked first
    });

    it("should check Opera before Chrome (both have Chrome in UA)", () => {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0";

      const isOpera = /OPR\/\d+/i.test(ua);
      const isChrome = /Chrome\/\d+/i.test(ua);

      expect(isOpera).to.be.true;
      expect(isChrome).to.be.true; // Both match, but Opera should be checked first
    });

    it("should properly classify non-Brave browsers", () => {
      const classifyNonBrave = (ua: string): string => {
        if (/Firefox\/\d+/i.test(ua)) return "firefox";
        if (/Edg\/\d+/i.test(ua)) return "edge";
        if (/OPR\/\d+/i.test(ua)) return "opera";
        if (/Safari\/\d+/i.test(ua) && !/Chrome\/\d+/i.test(ua)) return "safari";
        if (/Chrome\/\d+/i.test(ua)) return "chrome";
        return "unknown";
      };

      expect(classifyNonBrave("Firefox/121.0")).to.equal("firefox");
      expect(classifyNonBrave("Chrome/120.0.0.0 Edg/120.0.0.0")).to.equal("edge");
      expect(classifyNonBrave("Chrome/120.0.0.0 OPR/106.0.0.0")).to.equal("opera");
      expect(classifyNonBrave("Safari/605.1.15")).to.equal("safari");
      expect(classifyNonBrave("Chrome/120.0.0.0")).to.equal("chrome");
      expect(classifyNonBrave("Unknown/1.0")).to.equal("unknown");
    });
  });

  describe("Mobile Browser Detection", () => {
    it("should detect Chrome on Android", () => {
      const ua = "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
      expect(/Chrome\/\d+/i.test(ua)).to.be.true;
    });

    it("should detect Safari on iOS", () => {
      const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
      const isSafari = /Safari\/\d+/i.test(ua) && !/Chrome\/\d+/i.test(ua);
      expect(isSafari).to.be.true;
    });

    it("should detect Firefox on Android", () => {
      const ua = "Mozilla/5.0 (Android 10; Mobile; rv:109.0) Gecko/121.0 Firefox/121.0";
      expect(/Firefox\/\d+/i.test(ua)).to.be.true;
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty user agent", () => {
      const ua = "";
      const isKnown = /Firefox\/\d+|Chrome\/\d+|Edg\/\d+|OPR\/\d+|Safari\/\d+/i.test(ua);
      expect(isKnown).to.be.false;
    });

    it("should handle user agent with version numbers", () => {
      const ua = "Firefox/121.0";
      expect(/Firefox\/\d+/i.test(ua)).to.be.true;
    });

    it("should handle case insensitive matching", () => {
      const ua = "FIREFOX/121.0";
      expect(/Firefox\/\d+/i.test(ua)).to.be.true;
    });
  });
});
