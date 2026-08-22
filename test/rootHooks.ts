import { FormoAnalytics } from "../src/FormoAnalytics";

/**
 * Mocha root hooks: clean up every SDK instance a test creates.
 *
 * Specs share one process and one set of DOM globals. An instance that is
 * never torn down keeps listening, so a later spec's `history.pushState` or
 * provider event drives it too. That showed up two ways: a 30s suite hang
 * from an orphan instance's batch timer (issue #338), and order-dependent
 * failures in specs that assert on what reached the wire.
 *
 * Doing this here rather than in each spec means a new spec cannot forget.
 * Specs that call `cleanup()` themselves stay correct: cleanup is idempotent.
 *
 * One ordering caveat: this runs AFTER the spec's own `afterEach`, so by the
 * time it fires a spec may already have deleted `window` / `document` or
 * closed its jsdom. Clearing timers and closing the queue do not care. Removing
 * DOM listeners would, which is why `EventQueue.onPageLeave()` captures its
 * targets at install time rather than reading the globals again here.
 */
type Init = typeof FormoAnalytics.init;

const live: FormoAnalytics[] = [];
const realInit: Init = FormoAnalytics.init.bind(FormoAnalytics);
const target = FormoAnalytics as unknown as { init: Init };

export const mochaHooks = {
  beforeAll() {
    target.init = async (...args: Parameters<Init>) => {
      const instance = await realInit(...args);
      live.push(instance);
      return instance;
    };
  },

  afterEach() {
    while (live.length) {
      try {
        live.pop()?.cleanup();
      } catch {
        // A spec may have stubbed the instance into an unusable shape; a
        // failed teardown must not mask the test's own result.
      }
    }
  },

  afterAll() {
    target.init = realInit;
  },
};
