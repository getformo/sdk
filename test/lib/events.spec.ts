import { describe, it } from "mocha";
import { expect } from "chai";
import { getCookieDomain } from "../../src/lib/event/utils";

describe("getCookieDomain", () => {
  it("should return the cookie domain format", () => {
    expect(getCookieDomain("192.168.0.1")).to.equal("");
    expect(getCookieDomain("localhost:3000")).to.equal("");
    expect(getCookieDomain("example.com")).to.equal(".example.com");
    expect(getCookieDomain("www.example.com")).to.equal(".example.com");
  });
});
