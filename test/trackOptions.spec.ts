import { describe, it } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { FormoAnalytics } from "../src/FormoAnalytics";

describe("track options", () => {
  it("accepts an idempotency key without breaking the callback position", async () => {
    const formo = Object.create(FormoAnalytics.prototype) as FormoAnalytics;
    const trackEvent = sinon.stub(formo as any, "trackEvent").resolves();
    const callback = sinon.spy();

    await formo.track(
      "Checkout Completed",
      { plan: "pro", amount: 99 },
      { source: "confirmation" },
      { idempotencyKey: "checkout-123", callback }
    );

    expect(trackEvent.calledOnce).to.be.true;
    expect(trackEvent.firstCall.args[1]).to.deep.equal({
      event: "Checkout Completed",
      idempotencyKey: "checkout-123",
    });
    expect(trackEvent.firstCall.args[4]).to.equal(callback);
  });

  it("continues to accept the legacy callback argument", async () => {
    const formo = Object.create(FormoAnalytics.prototype) as FormoAnalytics;
    const trackEvent = sinon.stub(formo as any, "trackEvent").resolves();
    const callback = sinon.spy();

    await formo.track("Checkout Completed", {}, {}, callback);

    expect(trackEvent.firstCall.args[1]).to.deep.equal({
      event: "Checkout Completed",
      idempotencyKey: undefined,
    });
    expect(trackEvent.firstCall.args[4]).to.equal(callback);
  });

  it("rejects empty idempotency keys instead of silently using random identity", async () => {
    const formo = Object.create(FormoAnalytics.prototype) as FormoAnalytics;
    const trackEvent = sinon.stub(formo as any, "trackEvent").resolves();

    await formo.track("Checkout Completed", {}, {}, { idempotencyKey: "" });
    await formo.track("Checkout Completed", {}, {}, { idempotencyKey: "   " });

    expect(trackEvent.called).to.be.false;
  });

  it("canonicalizes finite numeric idempotency keys", async () => {
    const formo = Object.create(FormoAnalytics.prototype) as FormoAnalytics;
    const trackEvent = sinon.stub(formo as any, "trackEvent").resolves();

    await formo.track("Checkout Completed", {}, {}, { idempotencyKey: 123 });

    expect(trackEvent.firstCall.args[1]).to.deep.equal({
      event: "Checkout Completed",
      idempotencyKey: "123",
    });
  });

  it("rejects invalid runtime keys without throwing into the host", async () => {
    const formo = Object.create(FormoAnalytics.prototype) as FormoAnalytics;
    const trackEvent = sinon.stub(formo as any, "trackEvent").resolves();
    const invalidKeys = [null, true, {}, NaN, Infinity, -Infinity];

    for (const idempotencyKey of invalidKeys) {
      await formo.track("Checkout Completed", {}, {}, {
        idempotencyKey,
      } as any);
    }

    expect(trackEvent.called).to.be.false;
  });
});
