import { describe, it } from "mocha";
import { expect } from "chai";
import { computeOptionsKey } from "../src/FormoAnalyticsProvider";
import { Options } from "../src/types";

/**
 * FormoAnalyticsProvider re-initialises the SDK when this key changes.
 * Every behavioural option must move the key; object identity must not,
 * or each render would tear the SDK down.
 */
describe("computeOptionsKey", () => {
  const wagmiBase = () =>
    ({ config: {} as never, queryClient: {} as never });

  it("is stable across re-created but equivalent options objects", () => {
    const a = computeOptionsKey({ tracking: true, wagmi: wagmiBase() } as Options);
    const b = computeOptionsKey({ tracking: true, wagmi: wagmiBase() } as Options);
    expect(a).to.equal(b);
  });

  it("changes when eip1193Fallback flips", () => {
    const off = computeOptionsKey({ wagmi: wagmiBase() } as Options);
    const on = computeOptionsKey({
      wagmi: { ...wagmiBase(), eip1193Fallback: true },
    } as Options);
    expect(on).to.not.equal(off);
  });

  it("changes when wagmi mode itself is added", () => {
    expect(computeOptionsKey({} as Options)).to.not.equal(
      computeOptionsKey({ wagmi: wagmiBase() } as Options)
    );
  });

  it("changes when evm tracking flips", () => {
    expect(computeOptionsKey({ evm: false } as Options)).to.not.equal(
      computeOptionsKey({} as Options)
    );
  });

  it("stays stable for the same Solana store", () => {
    const store = {} as never;
    expect(computeOptionsKey({ solana: { store } })).to.equal(
      computeOptionsKey({ solana: { store } })
    );
  });

  it("changes when the Solana store instance is replaced", () => {
    expect(
      computeOptionsKey({ solana: { store: {} as never } })
    ).to.not.equal(
      computeOptionsKey({ solana: { store: {} as never } })
    );
  });

  it("handles absent options", () => {
    expect(computeOptionsKey(undefined)).to.equal("undefined");
  });
});
