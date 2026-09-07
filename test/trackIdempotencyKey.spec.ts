import { describe, it } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { FormoAnalytics } from "../src/FormoAnalytics";

// track() reads the reserved idempotency_key property, hands it to the event
// pipeline as the wire identity, and strips it from the sent properties.
describe("track idempotency_key property", () => {
  const setup = () => {
    const formo = Object.create(FormoAnalytics.prototype) as FormoAnalytics;
    const trackEvent = sinon.stub(formo as any, "trackEvent").resolves();
    return { formo, trackEvent };
  };

  it("lifts the key out of the properties and keeps the callback position", async () => {
    const { formo, trackEvent } = setup();
    const callback = sinon.spy();

    await formo.track(
      "Checkout Completed",
      { plan: "pro", amount: 99, idempotency_key: "checkout-123" },
      { source: "confirmation" },
      callback
    );

    expect(trackEvent.calledOnce).to.be.true;
    expect(trackEvent.firstCall.args[1]).to.deep.equal({
      event: "Checkout Completed",
      idempotencyKey: "checkout-123",
    });
    expect(trackEvent.firstCall.args[2]).to.deep.equal({ plan: "pro", amount: 99 });
    expect(trackEvent.firstCall.args[3]).to.deep.equal({ source: "confirmation" });
    expect(trackEvent.firstCall.args[4]).to.equal(callback);
  });

  it("does not mutate the caller's properties object", async () => {
    const { formo, trackEvent } = setup();
    const properties = { plan: "pro", idempotency_key: "checkout-123" };

    await formo.track("Checkout Completed", properties);

    expect(properties).to.deep.equal({ plan: "pro", idempotency_key: "checkout-123" });
    expect(trackEvent.firstCall.args[2]).to.deep.equal({ plan: "pro" });
  });

  it("ignores an inherited idempotency_key: only an own property is a key", async () => {
    const { formo, trackEvent } = setup();
    const properties = Object.create({ idempotency_key: "inherited" });
    properties.plan = "pro";

    await formo.track("Checkout Completed", properties);

    expect(trackEvent.calledOnce).to.be.true;
    expect(trackEvent.firstCall.args[1].idempotencyKey).to.equal(undefined);
    expect(trackEvent.firstCall.args[2]).to.equal(properties);
  });

  it("sends unkeyed calls with no identity and untouched properties", async () => {
    const { formo, trackEvent } = setup();
    const callback = sinon.spy();

    await formo.track("Checkout Completed", { plan: "pro" }, {}, callback);

    expect(trackEvent.firstCall.args[1]).to.deep.equal({
      event: "Checkout Completed",
      idempotencyKey: undefined,
    });
    expect(trackEvent.firstCall.args[2]).to.deep.equal({ plan: "pro" });
    expect(trackEvent.firstCall.args[4]).to.equal(callback);
  });

  it("canonicalizes finite numeric keys to their string form", async () => {
    const { formo, trackEvent } = setup();

    await formo.track("Checkout Completed", { idempotency_key: 123 });
    await formo.track("Checkout Completed", { idempotency_key: 0 });

    expect(trackEvent.firstCall.args[1].idempotencyKey).to.equal("123");
    expect(trackEvent.secondCall.args[1].idempotencyKey).to.equal("0");
  });

  it("rejects empty and whitespace-only keys instead of using random identity", async () => {
    const { formo, trackEvent } = setup();

    await formo.track("Checkout Completed", { idempotency_key: "" });
    await formo.track("Checkout Completed", { idempotency_key: "   " });

    expect(trackEvent.called).to.be.false;
  });

  it("rejects other runtime values without throwing into the host", async () => {
    const { formo, trackEvent } = setup();
    const invalidKeys = [null, undefined, true, {}, [], NaN, Infinity, -Infinity];

    for (const idempotency_key of invalidKeys) {
      await formo.track("Checkout Completed", { idempotency_key });
    }

    expect(trackEvent.called).to.be.false;
  });
});
