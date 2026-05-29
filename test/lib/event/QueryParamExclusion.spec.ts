import { expect } from "chai";
import "global-jsdom/register";
import { EventFactory } from "../../../src/event/EventFactory";

/**
 * Tests for sensitive query-parameter exclusion in page properties.
 *
 * The built-in denylist (privy_oauth_code, privy_oauth_state) is always
 * stripped regardless of configuration; consumers can add more keys via
 * tracking.excludeQueryParams. Only the query string is redacted — the URL
 * hash/fragment is intentionally left untouched.
 */
describe("EventFactory query parameter exclusion", () => {
  const setLocation = (url: string) => {
    const u = new URL(url);
    Object.defineProperty(window, "location", {
      value: {
        href: u.href,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        host: u.host,
        hostname: u.hostname,
        origin: u.origin,
        protocol: u.protocol,
      },
      writable: true,
      configurable: true,
    });
  };

  it("always strips the built-in Privy OAuth params with no config", async () => {
    setLocation(
      "https://example.com/callback?privy_oauth_code=SECRET_CODE&privy_oauth_state=CSRF_TOKEN&foo=bar"
    );
    const factory = new EventFactory();
    const event = await factory.generatePageEvent("cat", "name");

    // Removed from url, query string, and the per-parameter explosion.
    expect(event.properties?.url).to.not.contain("SECRET_CODE");
    expect(event.properties?.url).to.not.contain("CSRF_TOKEN");
    expect(event.properties?.query).to.not.contain("privy_oauth_code");
    expect(event.properties?.query).to.not.contain("privy_oauth_state");
    expect(event.properties?.privy_oauth_code).to.be.undefined;
    expect(event.properties?.privy_oauth_state).to.be.undefined;

    // Benign params are retained.
    expect(event.properties?.foo).to.equal("bar");
    expect(event.properties?.query).to.equal("foo=bar");
  });

  it("matches the built-in params case-insensitively", async () => {
    setLocation(
      "https://example.com/callback?PRIVY_OAUTH_CODE=SECRET_CODE&keep=1"
    );
    const factory = new EventFactory();
    const event = await factory.generatePageEvent("cat", "name");

    expect(event.properties?.url).to.not.contain("SECRET_CODE");
    expect(event.properties?.keep).to.equal("1");
  });

  it("strips additional params from tracking.excludeQueryParams on top of defaults", async () => {
    setLocation(
      "https://example.com/page?token=ABC&privy_oauth_code=SECRET_CODE&page=2"
    );
    const factory = new EventFactory({
      tracking: { excludeQueryParams: ["token"] },
    });
    const event = await factory.generatePageEvent("cat", "name");

    expect(event.properties?.url).to.not.contain("ABC");
    expect(event.properties?.url).to.not.contain("SECRET_CODE");
    expect(event.properties?.token).to.be.undefined;
    expect(event.properties?.privy_oauth_code).to.be.undefined;
    expect(event.properties?.page).to.equal("2");
  });

  it("leaves the URL hash/fragment untouched", async () => {
    setLocation(
      "https://example.com/callback?privy_oauth_code=SECRET_CODE#privy_oauth_state=HASH_KEPT"
    );
    const factory = new EventFactory();
    const event = await factory.generatePageEvent("cat", "name");

    expect(event.properties?.url).to.not.contain("SECRET_CODE");
    expect(event.properties?.url).to.contain("#privy_oauth_state=HASH_KEPT");
    expect(event.properties?.hash).to.equal("#privy_oauth_state=HASH_KEPT");
    expect(event.properties?.query).to.equal("");
  });
});
