import { describe, it } from "mocha";
import { expect } from "chai";
import {
  EVENTS_API_HOST,
  EVENTS_API_ORIGIN,
  USER_PROFILES_API_HOST,
  USER_LABELS_API_HOST,
  USER_PROFILES_DATASOURCE,
  USER_LABELS_DATASOURCE,
  resolveDatasourceHost,
} from "../../src/constants";

/**
 * resolveDatasourceHost() derives the user_profiles / user_labels ingest URLs
 * from the configured events apiHost, reusing the same Events API origin.
 */
describe("resolveDatasourceHost", () => {
  it("maps the default events host to sibling datasource paths", () => {
    expect(
      resolveDatasourceHost(EVENTS_API_HOST, undefined, USER_PROFILES_DATASOURCE)
    ).to.equal(USER_PROFILES_API_HOST);
    expect(
      resolveDatasourceHost(EVENTS_API_HOST, undefined, USER_LABELS_DATASOURCE)
    ).to.equal(USER_LABELS_API_HOST);
    expect(USER_PROFILES_API_HOST).to.equal(
      `${EVENTS_API_ORIGIN}/v0/user_profiles`
    );
  });

  it("prefers an explicit override over derivation", () => {
    expect(
      resolveDatasourceHost(
        EVENTS_API_HOST,
        "https://proxy.example.com/profiles",
        USER_PROFILES_DATASOURCE
      )
    ).to.equal("https://proxy.example.com/profiles");
  });

  it("swaps the trailing /raw_events segment of a custom host", () => {
    expect(
      resolveDatasourceHost(
        "https://my-proxy.com/ingest/raw_events",
        undefined,
        USER_PROFILES_DATASOURCE
      )
    ).to.equal("https://my-proxy.com/ingest/user_profiles");
    expect(
      resolveDatasourceHost(
        "https://my-proxy.com/ingest/raw_events",
        undefined,
        USER_LABELS_DATASOURCE
      )
    ).to.equal("https://my-proxy.com/ingest/user_labels");
  });

  it("returns null for a non-derivable custom proxy host", () => {
    expect(
      resolveDatasourceHost(
        "/api/analytics",
        undefined,
        USER_PROFILES_DATASOURCE
      )
    ).to.equal(null);
    expect(
      resolveDatasourceHost(
        "https://my-proxy.com/ingest",
        undefined,
        USER_LABELS_DATASOURCE
      )
    ).to.equal(null);
  });
});
