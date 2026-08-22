import { ChainID, Options, TrackingOptions } from "../types";
import { getTimezone } from "../utils/timezone";
import { isLocalhost } from "../validators";

/** Wallet event kinds that `autocapture` can switch on or off individually. */
export type AutocaptureEventType =
  | "connect"
  | "disconnect"
  | "signature"
  | "transaction"
  | "chain";

/**
 * What the policy knows about the event being considered.
 *
 * An object rather than a bare chain id on purpose. The `excludeChains` fix
 * had to thread an explicit chain through every gate because the policy had
 * no identity of its own, and each further per-event input would widen those
 * signatures again. New inputs extend this type instead.
 */
export interface TrackingContext {
  /**
   * The event's own chain, when it has one. It wins over the SDK's central
   * chain, because the two differ whenever the event did not come from the
   * active provider: a second wallet signing through its own transport, or a
   * wagmi mutation naming an explicit chain.
   */
  chainId?: ChainID;
}

/** What the policy needs from the SDK it advises. */
export interface TrackingPolicyDeps {
  /** Consent state. Separate from options because the visitor can change it. */
  hasOptedOut(): boolean;
  /** The SDK's central chain, used when an event carries none of its own. */
  currentChainId(): ChainID | undefined;
}

export interface ITrackingPolicy {
  shouldTrack(context?: TrackingContext): boolean;
  isTrackingSuppressed(): boolean;
  isChainExcluded(context?: TrackingContext): boolean;
  isPageExcluded(): boolean;
  isPersistedIdentityPurgeRequired(): boolean;
  isAutocaptureEnabled(eventType: AutocaptureEventType): boolean;
}

/**
 * Every "may we track this?" decision, in one place.
 *
 * Split out of `FormoAnalytics` so the rules can be read and tested without
 * an SDK instance, and so option parsing happens once rather than being
 * re-derived at each gate.
 */
export class TrackingPolicy implements ITrackingPolicy {
  constructor(
    private readonly options: Options,
    private readonly deps: TrackingPolicyDeps
  ) {}

  /**
   * `tracking` as an options object, or null when it is absent, a boolean, or
   * anything else. Every exclusion rule lives on the object form, so a null
   * here means "no exclusions configured", not "excluded".
   */
  private trackingOptions(): TrackingOptions | null {
    const tracking = this.options.tracking;
    if (
      tracking === null ||
      typeof tracking !== "object" ||
      Array.isArray(tracking)
    ) {
      return null;
    }
    return tracking as TrackingOptions;
  }

  /**
   * Visitor-level tracking suppression.
   *
   * True when the SDK must not persist any identity/session/chain state or
   * send any events for this visitor: an explicit opt-out, or a
   * jurisdiction/timezone/host/path exclusion. Public entry points that write
   * state before reaching `shouldTrack()` (identify / connect / detect) check
   * this first, so a suppressed visitor leaves no cookies or session state.
   */
  isTrackingSuppressed(): boolean {
    return this.deps.hasOptedOut() || this.isEnvironmentExcluded();
  }

  /**
   * Whether the environment is excluded: the visitor's timezone, the current
   * hostname, or the current pathname.
   *
   * Timezone is visitor-level and stable for the session. Host and path are
   * current-page-level and transient, so a SPA navigating back to an allowed
   * path resumes tracking for later actions.
   */
  private isEnvironmentExcluded(): boolean {
    return (
      this.isTimezoneExcluded() ||
      this.isHostExcluded() ||
      this.isPathExcluded()
    );
  }

  /** Exact match against `tracking.excludeHosts`. */
  private isHostExcluded(): boolean {
    const tracking = this.trackingOptions();
    if (!tracking) return false;
    if (typeof window === "undefined") return false;
    const { excludeHosts = [] } = tracking;
    return excludeHosts.includes(window.location.hostname);
  }

  /** Exact match against `tracking.excludePaths`. */
  private isPathExcluded(): boolean {
    const tracking = this.trackingOptions();
    if (!tracking) return false;
    if (typeof window === "undefined") return false;
    const { excludePaths = [] } = tracking;
    return excludePaths.includes(window.location.pathname);
  }

  /**
   * Case-insensitive match of the browser-resolved timezone against
   * `tracking.excludeTimezones`. Client-side and best-effort; see the option's
   * own documentation.
   */
  private isTimezoneExcluded(): boolean {
    const tracking = this.trackingOptions();
    if (!tracking) return false;
    const { excludeTimezones = [] } = tracking;
    if (excludeTimezones.length === 0) return false;
    const timezone = getTimezone();
    if (!timezone) return false;
    const lowerTimezone = timezone.toLowerCase();
    return excludeTimezones.some(
      (tz) => typeof tz === "string" && tz.toLowerCase() === lowerTimezone
    );
  }

  /**
   * Whether the CURRENT PAGE is excluded, as opposed to the visitor.
   *
   * Host and path exclusions are transient: identity written on an allowed
   * page must survive a visit to an excluded route, so callers that persist
   * or restore identity skip the work here rather than purging.
   */
  isPageExcluded(): boolean {
    return this.isHostExcluded() || this.isPathExcluded();
  }

  /**
   * Whether a persisted identity cookie should be actively purged, not merely
   * left unwritten.
   *
   * Host and path exclusions are deliberately absent: they are transient
   * current-page states, so a cookie legitimately written on an allowed page
   * must survive a visit to an excluded route.
   */
  isPersistedIdentityPurgeRequired(): boolean {
    return this.deps.hasOptedOut() || this.isTimezoneExcluded();
  }

  /**
   * Whether the chain in play is in `tracking.excludeChains`.
   *
   * Separate from `shouldTrack()` so `identify()` can ask *before* mutating
   * identity state. `trackEvent()` drops an excluded event silently, but
   * `identify()` marks the wallet as identified first, so without this an
   * identify on an excluded chain is dedup-marked and then discarded, and the
   * wallet never re-emits for the rest of the session even after switching to
   * an allowed chain. On the Privy path that loses a whole cluster at once.
   */
  isChainExcluded(context?: TrackingContext): boolean {
    const tracking = this.trackingOptions();
    if (!tracking) return false;
    const { excludeChains = [] } = tracking;
    if (excludeChains.length === 0) return false;
    return this.isChainRefused(excludeChains, context);
  }

  /**
   * The shared chain rule, so `shouldTrack()` and `isChainExcluded()` cannot
   * drift apart. Callers have already established that `excludeChains` is
   * non-empty.
   *
   * Fails CLOSED on an unknown chain. `resolveChainIdForProvider` reports 0
   * when it has never heard a chain from the signing wallet, and 0 is in no
   * exclusion list, so treating it as "not excluded" would let through exactly
   * the events an operator excluded: the wallet on the excluded chain is often
   * the one we know least about. An explicit exclusion is a directive, so an
   * unresolvable chain is refused.
   *
   * Keyed on 0 and deliberately NOT on `undefined`. 0 is the explicit "we
   * asked and could not tell" marker. `undefined` means no chain state yet,
   * which is a legitimate transient (the Privy path reconciles a Solana wallet
   * through exactly that state), and refusing it would drop real events.
   * `backfillActiveWallet()` never persists 0, so an unresolvable chain cannot
   * leak into the central value and reach the unscoped events (page / track /
   * identify) that fall back to it.
   */
  private isChainRefused(
    excludeChains: ChainID[],
    context?: TrackingContext
  ): boolean {
    const chainToCheck = context?.chainId ?? this.deps.currentChainId();
    if (chainToCheck === 0) return true;
    if (chainToCheck === undefined) return false;
    return excludeChains.includes(chainToCheck);
  }

  /** Whether an event may be tracked at all, given consent and configuration. */
  shouldTrack(context?: TrackingContext): boolean {
    if (this.deps.hasOptedOut()) return false;

    // An explicit boolean is the whole answer; no exclusions apply to it.
    if (typeof this.options.tracking === "boolean") {
      return this.options.tracking;
    }

    const tracking = this.trackingOptions();
    if (tracking) {
      if (this.isEnvironmentExcluded()) return false;

      const { excludeChains = [] } = tracking;
      if (excludeChains.length > 0 && this.isChainRefused(excludeChains, context)) {
        return false;
      }
      return true;
    }

    // Nothing configured: track everywhere except localhost.
    return !isLocalhost();
  }

  /** Whether a wallet event kind is enabled for autocapture. Defaults to on. */
  isAutocaptureEnabled(eventType: AutocaptureEventType): boolean {
    const { autocapture } = this.options;
    if (autocapture === undefined) return true;
    if (typeof autocapture === "boolean") return autocapture;
    if (autocapture !== null && typeof autocapture === "object") {
      // Only an explicit false disables a kind.
      return autocapture[eventType] !== false;
    }
    return true;
  }
}
