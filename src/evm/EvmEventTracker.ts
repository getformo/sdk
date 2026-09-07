import { EIP6963ProviderDetail, createStore } from "mipd";
import { logger } from "../logger";
import { parseChainId } from "../utils/chain";
import { validateAndChecksumAddress } from "../utils/address";
import { detectInjectedProviderInfo, isValidProvider, DEFAULT_PROVIDER_ICON } from "../provider";
import {
  Address,
  ChainID,
  ConnectInfo,
  EIP1193Provider,
  IFormoEventProperties,
} from "../types";
import { WalletStateStore, Observation } from "../wallet/WalletStateStore";
import { EvmProviderRegistry } from "./EvmProviderRegistry";
import { AutocaptureEventType } from "../tracking/TrackingPolicy";

/** Why the tracker moved the active slot to another provider. Log copy. */
const PROVIDER_SWITCH_REASONS = {
  ADDRESS_MISMATCH: "Address mismatch indicates wallet switch",
  NO_ACCOUNTS: "Current provider has no accounts",
  CHECK_FAILED: "Could not check current provider accounts",
} as const;

/** What the tracker needs from the SDK that owns it. */
export interface EvmEventTrackerDeps {
  /** Whether this wallet event kind is enabled for autocapture. */
  isAutocaptureEnabled(eventType: AutocaptureEventType): boolean;
  /** Visitor-level or page-level suppression: never LEARN a wallet. */
  isTrackingSuppressed(): boolean;
  /** Whether an event on this chain would actually be sent. */
  willTrackEvent(chainId?: ChainID): boolean;
  /** Retry detect events after the active chain changes. */
  retryDetection(): void;
  /** In wagmi mode the SDK does not wrap providers itself. */
  isWagmiMode(): boolean;

  /** Emission. The tracker decides WHEN; the SDK owns the event API. */
  connect(
    params: { chainId: ChainID; address: Address },
    properties?: IFormoEventProperties
  ): Promise<void>;
  disconnect(params?: { chainId?: ChainID; address?: Address }): Promise<void>;
  chain(
    params: { chainId: ChainID; address?: Address },
    properties?: IFormoEventProperties
  ): Promise<void>;
  /**
   * `rdns` is the session dedup key for detect, so it must reach `detect()`
   * exactly as the wallet announced it. Required here rather than optional
   * so no caller can quietly substitute a placeholder for a missing value.
   */
  detect(params: { providerName: string; rdns: string }): Promise<void>;

  /**
   * Install the request wrapper that captures signatures and transactions.
   *
   * Still owned by the SDK: it is the next thing to move, and keeping it out
   * of this change keeps the diff reviewable.
   */
  registerRequestListeners(provider: EIP1193Provider): boolean;
}

/**
 * The EIP-1193 side of wallet tracking: which providers to watch, and what
 * their events mean.
 *
 * Split out of `FormoAnalytics` (#336). It holds no wallet state and no
 * provider registry of its own - those have owners already - so what is left
 * here is the part that is genuinely about interpreting wallet events:
 * deciding when a connect has to be reported, when a switch is stale, and
 * when a provider has stopped being the one we follow.
 */
/**
 * A registered provider's current accounts, from its synchronous state.
 *
 * `provider.accounts` first - but a LIVE MetaMask Mobile session over
 * WalletConnect has been observed with `accounts` EMPTY while the session's
 * namespaces held the approved account ("eip155:11155111:0xabc..."), which
 * silently defeated adoption. The namespaces are the session's ground
 * truth, so they are the fallback. Still purely synchronous property
 * reads; nothing goes on the wallet transport.
 */
function readProviderAccounts(provider: EIP1193Provider): string[] {
  const direct = (provider as unknown as { accounts?: unknown }).accounts;
  if (
    Array.isArray(direct) &&
    direct.length > 0 &&
    direct.every((a) => typeof a === "string")
  ) {
    return direct as string[];
  }
  const session = (provider as unknown as {
    session?: { namespaces?: Record<string, { accounts?: unknown }> };
  }).session;
  // eip155 ONLY: a session can also carry Solana or other namespaces, and
  // feeding a non-EVM address into the EVM adoption path would make
  // validation reject it and drop the whole adoption. A session can also
  // authorize DIFFERENT accounts per chain, so entries for the provider's
  // active chain come first - the adopted address should be the one this
  // chain actually authorized.
  const ns = session?.namespaces?.eip155;
  const chainId = (provider as unknown as { chainId?: unknown }).chainId;
  const parsed =
    typeof chainId === "number"
      ? chainId
      : typeof chainId === "string"
        ? parseChainId(chainId)
        : undefined;
  const activePrefix = parsed ? `eip155:${parsed}:` : undefined;
  const forChain: string[] = [];
  const others: string[] = [];
  if (Array.isArray(ns?.accounts)) {
    for (const entry of ns.accounts) {
      if (typeof entry !== "string" || !entry.startsWith("eip155:")) continue;
      const address = entry.split(":")[2];
      if (!address) continue;
      const bucket =
        activePrefix && entry.startsWith(activePrefix) ? forChain : others;
      if (!bucket.includes(address)) bucket.push(address);
    }
  }
  const out = [...forChain, ...others.filter((a) => !forChain.includes(a))];
  return out;
}

export class EvmEventTracker {
  /**
   * Providers adopted through `registerProvider` rather than discovered.
   * Announcement-driven cleanup must not touch them: they are never in an
   * announcement list, so "missing from the announcement" is their normal
   * state, not evidence of removal. A Set rather than a WeakSet because
   * the corrected-detect pass iterates it; the registry's detail list
   * holds these providers strongly for the instance's life anyway.
   */
  private externallyRegistered = new Set<EIP1193Provider>();

  /**
   * Registered providers whose session this SDK has NOT yet learned.
   *
   * Only these are retried on page hits and opt-in. Re-running adoption for
   * every registered provider looked idempotent but was not: adoption is
   * the same path a live `accountsChanged` takes, and that path treats a
   * provider with a different address from the active one as a wallet
   * switch. With two registered providers, or one registered next to a
   * discovered wallet, every page hit emitted a disconnect and a connect
   * that no user action caused.
   *
   * A provider enters at registration (it may have no session yet, or be
   * refused because tracking is suppressed), again whenever a handler
   * refuses its signal while suppressed (noted on entry AND at the
   * suppressed commit, since the handlers gate on the active provider and
   * re-check suppression after an await), and again for all of them when
   * an opt-out purges identity. It leaves the first time a handler commits
   * its session unsuppressed, or when it is untracked. Retrying reads the
   * provider's SYNCHRONOUS accounts only - no RPC - so a registered
   * provider whose session never fires `accountsChanged` (a wallet that
   * signals `connect` alone while `autocapture.connect` is off, which
   * installs a chain-only observer) is still adopted on the next hit. "No
   * RPC" holds for the pending provider itself; the handler's switch
   * arbitration may still ask the ACTIVE provider for its accounts, as it
   * does for any live signal.
   *
   * Replay goes through the accounts handler, which has live wallet-switch
   * semantics: a different provider with a different address is a switch.
   * So a pending provider is replayed only while no OTHER wallet is active
   * and known - it waits, at no cost, until that wallet is gone - unless
   * its own signal was refused (`latestRefused`): then the replay does
   * exactly what the live signal would have done, switch included.
   */
  private pendingAdoptions = new Set<EIP1193Provider>();

  /**
   * The pending provider whose own live signal was refused while
   * suppressed, LATEST only. The SDK follows one active wallet and the
   * newest signal wins, so replaying only the last refused signal reaches
   * the state the live signals would have reached, without the switches
   * in between; an earlier refused provider stays pending, unprivileged.
   */
  private latestRefused?: EIP1193Provider;

  private dropRefusal(provider: EIP1193Provider): void {
    if (this.latestRefused === provider) this.latestRefused = undefined;
  }

  /**
   * An opt-out purges wallet identity. Every registered session is then
   * unknown again (pending; no refusal is ADDED, so the opt-in replay of a
   * merely connected wallet does not switch, while a refusal already
   * standing from an excluded route keeps its meaning), and the
   * opt-in retry must re-learn all of them: with the active wallet's
   * address gone, the accounts handler cannot even tell a second wallet's
   * accounts apart from the active one's, and would ignore them.
   */
  markRegisteredAdoptionsPending(): void {
    this.externallyRegistered.forEach((provider) =>
      this.pendingAdoptions.add(provider)
    );
  }

  /**
   * Remember a registered provider's signal that suppression refuses.
   *
   * Replay privilege (`latestRefused`) goes only to a provider whose
   * session the replay can actually read - synchronous accounts - so an
   * accountless `connect` (a chain-only observation, or a session still
   * pairing) cannot displace an earlier refusal that is adoptable.
   */
  private noteRefusalIfSuppressed(provider: EIP1193Provider): void {
    if (
      this.deps.isTrackingSuppressed() &&
      this.externallyRegistered.has(provider)
    ) {
      this.pendingAdoptions.add(provider);
      let adoptable = false;
      try {
        adoptable = readProviderAccounts(provider).length > 0;
      } catch {
        /* unreadable state: pending, not privileged */
      }
      if (adoptable) this.latestRefused = provider;
    }
  }

  /**
   * Registered providers whose session ended and have not signalled a
   * new one. Some providers keep stale synchronous `accounts` after a
   * disconnect; replaying those would re-install a session that is over.
   * Any later session signal (connect, accountsChanged) lifts this.
   */
  private awaitingNewSession = new Set<EIP1193Provider>();

  /** A handler has learned this provider's session; nothing is pending. */
  private settleAdoption(provider: EIP1193Provider): void {
    this.pendingAdoptions.delete(provider);
    this.awaitingNewSession.delete(provider);
    this.dropRefusal(provider);
  }

  /**
   * A registered provider's session has ended. Its NEXT session is not
   * yet learned, and may announce itself in a way no handler adopts (a
   * `connect` alone while `autocapture.connect` is off installs a
   * chain-only observer), so it is pending again for the page-hit retry.
   */
  private reopenAdoption(provider: EIP1193Provider): void {
    if (this.externallyRegistered.has(provider)) {
      this.pendingAdoptions.add(provider);
      this.awaitingNewSession.add(provider);
      // A lookup still in flight for the session that just ended must not
      // record a refusal for it when it resolves.
      this.sessionGenerations.set(
        provider,
        (this.sessionGenerations.get(provider) ?? 0) + 1
      );
      // The refusal marker described the session that just ended. Left
      // standing, a later connect-only session would inherit it and be
      // replayed as a switch away from another active wallet.
      this.dropRefusal(provider);
    }
  }

  /** One retry scan at a time; a call during a scan queues one more. */
  private retryInFlight = false;
  private retryRequested = false;

  /**
   * The connect this SDK has already reported for a provider.
   *
   * Connection REPORTING, which is why it lives with the handlers rather than
   * with wallet state. The store tells us when a provider stops being active,
   * which is when a record must lapse.
   */
  private _announcedConnect = new WeakMap<
    EIP1193Provider,
    { address: string; chainId: number }
  >();

  /**
   * The EIP-6963 discovery subscription, so teardown can release it. Left
   * live, a disposed SDK kept reacting to every later wallet announcement:
   * wrapping providers and emitting detect events from an instance the host
   * had already replaced.
   */
  private unsubscribeDiscovery?: () => void;
  /** Discovery store retained for complete listener cleanup. */
  private discoveryStore?: ReturnType<typeof createStore>;

  constructor(
    private readonly wallet: WalletStateStore,
    private readonly registry: EvmProviderRegistry,
    private readonly deps: EvmEventTrackerDeps
  ) {}

  /** Stop listening for wallet announcements. Called from SDK teardown. */
  cleanup(): void {
    // A replay in flight (awaiting the active wallet's accounts) must not
    // resume into a torn-down instance and commit a session there.
    this.disposed = true;
    this.pendingAdoptions.clear();
    this.awaitingNewSession.clear();
    this.latestRefused = undefined;
    this.retryRequested = false;
    try {
      this.unsubscribeDiscovery?.();
      this.discoveryStore?.destroy();
    } catch (e) {
      logger.warn("Failed to unsubscribe from provider discovery", e);
    }
    this.unsubscribeDiscovery = undefined;
    this.discoveryStore = undefined;
  }

  /** Set by `cleanup()`; every awaited continuation checks it. */
  private disposed = false;

  /** Bumped when a registered provider's session ends. See reopenAdoption. */
  private sessionGenerations = new WeakMap<EIP1193Provider, number>();

  private sessionGeneration(provider: EIP1193Provider): number {
    return this.sessionGenerations.get(provider) ?? 0;
  }

  /** Drop a provider's reported connect. Called when it stops being active. */
  forgetAnnouncedConnect(provider: EIP1193Provider): void {
    this._announcedConnect.delete(provider);
  }

  /**
   * Helper method to check if a provider is different from the currently active one
   * @param provider The provider to check
   * @returns true if there's a provider mismatch, false otherwise
   */
  private isProviderMismatch(provider: EIP1193Provider): boolean {
    // Only consider it a mismatch if we have an active provider AND the provider is different
    // This allows legitimate provider switching while preventing race conditions
    return this.wallet.provider != null && this.wallet.provider !== provider;
  }

  /**
   * Track an EIP-1193 provider by wrapping its request method and adding event listeners
   * Note: This is only used in non-Wagmi mode. When Wagmi is enabled, all tracking
   * happens through Wagmi's connector system instead of EIP-1193/EIP-6963.
   * @param provider The EIP-1193 provider to track
   */
  trackEIP1193Provider(provider: EIP1193Provider): void {
    logger.info("trackEIP1193Provider", provider);
    
    // Defensive check: Skip provider tracking in Wagmi mode
    // This should never be called in Wagmi mode due to guards in init(),
    // but we check here for safety in case of future code changes
    if (this.deps.isWagmiMode()) {
      logger.debug("trackEIP1193Provider: Skipping EIP-1193 provider tracking (Wagmi mode - using connector system instead)");
      return;
    }
    
    try {
      // Validate provider exists and has required methods
      if (!isValidProvider(provider)) {
        logger.warn("trackEIP1193Provider: Invalid provider - missing required methods");
        return;
      }
      
      if (this.registry.isTracked(provider)) {
        logger.warn("trackEIP1193Provider: Provider already tracked");
        return;
      }

      // CRITICAL: Always register accountsChanged for state management
      // This ensures currentAddress, currentChainId, and _provider are always up-to-date
      // Event emission is controlled conditionally inside the handlers
      this.registerAccountsChangedListener(provider);

      // `chainChanged` and `connect` are registered UNCONDITIONALLY: they are
      // how this provider's chain is observed, and every signature and
      // transaction has to be labelled with it. Gating registration on
      // `autocapture.chain` conflated observing a chain with reporting one, so
      // `{ chain: false, signature: true }` left the chain frozen at whatever
      // was first seen - a switch to an excluded chain went unnoticed and its
      // signatures were emitted under the old, allowed chain. Whether an
      // event is emitted is decided inside each handler.
      this.registerChainChangedListener(provider);
      if (this.deps.isAutocaptureEnabled("connect")) {
        this.registerConnectListener(provider);
      } else {
        // Observation only. The full connect handler calls `getAddress()`,
        // which issues `eth_accounts`, and nothing analytics-only may go on
        // the wallet's transport - a stalled request there sits in front of
        // the next signature the dapp makes. The chain rides along on the
        // event itself, so it costs nothing to record.
        this.registerConnectChainObserver(provider);
      }

      // Seed the chain from the provider's own synchronous state if it exposes
      // one. Deliberately a property read and never an RPC: see
      // resolveChainIdForProvider for why nothing analytics-only may go on the
      // wallet's transport.
      this.seedProviderChainFromState(provider);

      // Wrapped UNCONDITIONALLY. The wrapper checks the autocapture flags per
      // request, so skipping it here bought nothing and cost a real case: an
      // app that turned signature or transaction capture on after init had a
      // provider that was never wrapped, and never would be.
      if (!this.deps.registerRequestListeners(provider)) {
        // Not tracked: discovery would otherwise never retry it, and every
        // signature and transaction from this wallet would be missed.
        logger.warn("TrackProvider: Could not wrap provider; leaving it untracked");
        return;
      }

      // Registered UNCONDITIONALLY: this listener also ends the provider's
      // reported-connect record, and with `{ connect: true, disconnect: false }`
      // a wallet that disconnected and reconnected would otherwise find its
      // old record still standing and have the new connect suppressed. Whether
      // a disconnect EVENT is emitted is decided inside the handler.
      {
        this.registerDisconnectListener(provider);
      }

      // Only add to tracked providers after all listeners are successfully registered
      this.registry.markTracked(provider);
    } catch (error) {
      logger.error("Error tracking provider:", error);
    }
  }

  trackProviders(providers: readonly EIP6963ProviderDetail[]): void {
    try {
      for (const eip6963ProviderDetail of providers) {
        const provider = eip6963ProviderDetail?.provider as
          | EIP1193Provider
          | undefined;
        if (provider && !this.registry.isTracked(provider)) {
          this.trackEIP1193Provider(provider);
        }
      }
    } catch (error) {
      logger.error(
        "Failed to track EIP-6963 providers during initialization:",
        error
      );
    }
  }

  /**
   * Adopt a provider the page constructed rather than announced.
   *
   * Discovery only ever sees EIP-6963 announcements and `window.ethereum`.
   * A WalletConnect or Ledger provider is a constructed object that does
   * neither, so without this entry point its whole session is invisible -
   * the P-2403 gap. The pipeline from here on is the same one every
   * discovered provider takes: registry, detect event, listeners, request
   * wrapper.
   *
   * A session that already exists at registration is seeded from the
   * provider's SYNCHRONOUS `accounts` state (WalletConnect exposes it), via
   * the same accounts-arrival path a live `accountsChanged` takes. No RPC:
   * nothing analytics-only may go on a wallet's transport, and
   * WalletConnect's serialised relay socket is the very case that rule
   * exists for.
   */
  adoptExternalProvider(detail: EIP6963ProviderDetail): boolean {
    const provider = detail.provider as EIP1193Provider;
    // Exempt from announcement-driven cleanup BEFORE tracking: a registered
    // provider is never in an EIP-6963 announcement, so without this the
    // next wallet announcement would untrack it and its events would stop.
    this.externallyRegistered.add(provider);
    this.registry.add(detail);
    this.trackProviders([detail]);

    // Adoption and success both hinge on the wrapper actually installing:
    // reporting success for a provider whose requests stay invisible would
    // recreate the silent loss this API exists to close.
    if (!this.registry.isTracked(provider)) {
      this.externallyRegistered.delete(provider);
      // Tracking got partway: lifecycle listeners may already be attached
      // even though the request wrapper failed. Leaving them would leak
      // callbacks that hold this instance for the life of the page.
      this.untrackProvider(provider);
      logger.warn("adoptExternalProvider: provider could not be tracked");
      return false;
    }

    // A provider that was ALREADY tracked skips the pipeline above, and
    // "tracked" means lifecycle listeners - it says nothing about the
    // request wrapper, which a wallet can have replaced since. Re-verify
    // it on every registration: the call reinstalls a displaced wrapper,
    // rebinds ownership of an intact one, and refuses when it cannot -
    // and success here must mean capture actually works.
    if (!this.deps.registerRequestListeners(provider)) {
      this.externallyRegistered.delete(provider);
      this.untrackProvider(provider);
      logger.warn("adoptExternalProvider: request wrapper could not be ensured");
      return false;
    }

    // Detect with the LIVE name (peer-resolved when a session exists);
    // the stored metadata stays generic so later sessions rename freely.
    void this.detectWallets([
      { ...detail, info: { ...detail.info, ...this.registry.infoFor(provider) } },
    ]);

    // Pending until a handler commits its session unsuppressed: the
    // session may not exist yet, or adoption may be refused right below.
    this.pendingAdoptions.add(provider);
    const accounts = readProviderAccounts(provider);
    if (accounts.length > 0) {
      void this.onAccountsChanged(provider, accounts);
    }
    return true;
  }

  /**
   * Finish what registration could not.
   *
   * A registered provider's session may not have existed at registration,
   * or its adoption was refused because tracking was suppressed (opt-out,
   * excluded route) - and an existing session may never emit another
   * accountsChanged, so nothing else would ever retry. Called when
   * suppression can have ended (opt-in, page navigation).
   *
   * Adoption is retried ONLY for providers not yet adopted
   * (`pendingAdoptions`), only from their synchronous accounts, and only
   * once suppression has actually ended. The corrected-detect pass below
   * runs for every registered provider: it is deduplicated per session by
   * rdns, so repeating it is free.
   */
  retryExternalAdoptions(): void {
    this.externallyRegistered.forEach((provider) => {
      // A flagless provider registered BEFORE pairing detected as the
      // generic injected identity; once the session's peer exists, the
      // live identity differs and the corrected detect fires. The
      // session-scoped rdns dedup keeps this from repeating.
      const live = this.registry.infoFor(provider);
      if (live.rdns === "com.walletconnect") {
        void this.detectWallets([
          {
            info: {
              name: live.name,
              rdns: live.rdns,
              uuid: "corrected-com-walletconnect",
              icon: DEFAULT_PROVIDER_ICON,
            },
            provider: provider as never,
          },
        ]);
      }
    });

    if (
      this.disposed ||
      this.pendingAdoptions.size === 0 ||
      this.deps.isTrackingSuppressed()
    ) {
      // Nothing to finish, or still suppressed: adopting now would be
      // refused again, and the entry must survive for the next chance.
      return;
    }
    // ONE scan at a time, providers awaited in turn, and the entry is NOT
    // removed here: only a handler that commits the session removes it.
    // Fired concurrently - two overlapping scans from repeated page hits,
    // or two providers within one - the later call made the earlier
    // one's observation stale; a stale return dropped a provider whose
    // session was never learned, and a second scan replayed a provider
    // the first was still switching to, emitting the old wallet's
    // disconnect twice. A call that lands during a scan queues exactly
    // one more scan, so nothing that changed meanwhile is missed.
    if (this.retryInFlight) {
      this.retryRequested = true;
      return;
    }
    this.retryInFlight = true;
    void (async () => {
      try {
        do {
          this.retryRequested = false;
          // The ACTIVE provider goes first: an opt-out purges the address
          // but keeps the provider, and judged before it is re-learned,
          // every other pending provider looks like "another wallet with
          // accounts" and is ignored. The latest refused signal goes
          // next, as the newest signal it is; the rest follow, and are
          // skipped while another wallet stands.
          const first = [this.wallet.provider, this.latestRefused].filter(
            (p): p is EIP1193Provider => !!p && this.pendingAdoptions.has(p)
          );
          const ordered = Array.from(
            new Set([...first, ...Array.from(this.pendingAdoptions)])
          );
          for (const provider of ordered) {
            if (this.disposed || this.deps.isTrackingSuppressed()) break;
            let accounts: string[];
            try {
              accounts = readProviderAccounts(provider);
            } catch {
              // A wallet whose state getters throw (transport disposed)
              // stays pending; it must not abort the scan for the others,
              // nor surface as an unhandled rejection from this task.
              continue;
            }
            if (accounts.length === 0 || this.awaitingNewSession.has(provider)) {
              // No session yet, or none since the last one ended: stays
              // pending, at no cost.
              continue;
            }
            const otherWalletActive =
              this.wallet.provider !== undefined &&
              this.wallet.provider !== provider;
            if (otherWalletActive && this.latestRefused !== provider) {
              // Never signalled, merely connected: replaying it now would
              // be reported as a wallet switch nobody made. Waits for
              // that wallet to go.
              continue;
            }
            try {
              await this.onAccountsChanged(provider, accounts);
            } catch {
              /* stays pending */
            }
          }
        } while (
          this.retryRequested &&
          !this.disposed &&
          !this.deps.isTrackingSuppressed()
        );
      } finally {
        this.retryInFlight = false;
        this.retryRequested = false;
      }
    })();
  }

  private registerAccountsChangedListener(provider: EIP1193Provider): void {
    logger.info("registerAccountsChangedListener");
    const listener = (...args: unknown[]) =>
      this.onAccountsChanged(provider, args[0] as string[]);

    provider.on("accountsChanged", listener);
    this.registry.addListener(provider, "accountsChanged", listener);
  }

  private async onAccountsChanged(
    provider: EIP1193Provider,
    accounts: string[]
  ): Promise<void> {
    // A listener that could not be removed at cleanup (its provider's
    // removeListener threw) still fires; it must not touch a torn-down
    // instance.
    if (this.disposed) return;
    logger.info("onAccountsChanged", accounts);

    // Only a signal that can actually CLAIM the namespace takes a ticket.
    //
    // An empty `accountsChanged` from a provider that is not the active one
    // is ignored below, so letting it take a ticket would supersede a real
    // transition - including an active wallet's disconnect - on the strength
    // of an event we are about to discard. Accounts arriving always claim:
    // from the active provider it is a connect or switch, and from another it
    // is a wallet switch.
    const claims = accounts.length > 0 || this.wallet.provider === provider;
    const observation = claims
      ? this.wallet.observe("evm")
      : this.wallet.currentObservation("evm");

    // Take the ticket BEFORE any async work, so the order recorded is the
    // order the wallet's signals arrived in. This path used to DROP a second
    // `accountsChanged` while the first was in flight; dropping is not
    // ordering, and a wallet that disconnected and came straight back had its
    // reconnect thrown away.

    await this._handleAccountsChanged(provider, accounts, observation);
  }

  /**
   * Handles changes to the accounts of a given EIP-1193 provider.
   *
   * @param provider - The EIP-1193 provider whose accounts have changed.
   * @param accounts - The new array of account addresses. An empty array indicates a disconnect.
   * @returns A promise that resolves when the account change has been processed.
   *
   * If the accounts array is empty and the provider is the active provider, this method triggers
   * a disconnect flow. Otherwise, it updates the state to reflect the new accounts as needed.
   */
  private async _handleAccountsChanged(
    provider: EIP1193Provider,
    accounts: string[],
    observation: Observation
  ): Promise<void> {
    if (accounts.length === 0) {
      this.reopenAdoption(provider);
      // Handle wallet disconnect for active provider only
      if (this.wallet.provider === provider) {
        logger.info("OnAccountsChanged: Detecting disconnect, current state:", {
          evmAddress: this.wallet.evmAddress,
          evmChainId: this.wallet.evmChainId,
          providerMatch: this.wallet.provider === provider,
        });

        // The reported connect ends with the connection, so a genuine
        // reconnect later reports again rather than being taken for a
        // duplicate.
        this._announcedConnect.delete(provider);

        // Check if disconnect tracking is enabled before emitting event
        if (this.deps.isAutocaptureEnabled("disconnect")) {
          try {
            // Pass EVM state explicitly to ensure we have the data for the disconnect event
            await this.deps.disconnect({
              chainId: this.wallet.evmChainId,
              address: this.wallet.evmAddress,
            });
            // Torn down during the emission: nothing below may run.
            if (this.disposed) return;
            // Provider remains tracked to allow for reconnection scenarios
          } catch (error) {
            logger.error(
              "Failed to disconnect provider on accountsChanged",
              error
            );
            // Don't untrack if disconnect failed to maintain state consistency
          }
        } else {
          logger.debug("OnAccountsChanged: Disconnect event skipped (autocapture.disconnect: false)");
          // Whether the app opted into the EVENT has no bearing on ordering.
          this.wallet.beginDisconnect("evm");
          // Still clear state even if not tracking the event
          this.wallet.clear('evm');
        }
      } else {
        logger.info(
          "OnAccountsChanged: Ignoring disconnect for non-active provider"
        );
      }
      return;
    }

    // Validate and checksum the first account address
    const address = validateAndChecksumAddress(accounts[0]);
    if (!address) {
      logger.warn("onAccountsChanged: Invalid address received", accounts[0]);
      return;
    }
    // Before the active-provider gates below: a registered provider that
    // is not the active one can return early without ever reaching the
    // suppressed commit, and its session may never signal again.
    this.awaitingNewSession.delete(provider);
    this.noteRefusalIfSuppressed(provider);
    const session = this.sessionGeneration(provider);

    // Handle provider switching: if we have an active provider but a different provider
    // is connecting with accounts, check if the current provider is still connected
    if (this.wallet.provider && this.wallet.provider !== provider) {
      // Emitting the old wallet's disconnect is asynchronous, and a third
      // provider can claim the namespace during it (a `chainChanged` counts
      // as a wallet switch, so it does not need this handler at all). This
      // transition is then stale: installing it would overwrite a newer,
      // already-reported session. See issue #344.
      // Capture current EVM state BEFORE any changes
      const currentStoredAddress = this.wallet.evmAddress;
      const newProviderAddress = validateAndChecksumAddress(address);

      logger.info(
        "OnAccountsChanged: Different provider attempting to connect",
        {
          activeProvider: this.registry.infoFor(this.wallet.provider).name,
          eventProvider: this.registry.infoFor(provider).name,
          currentStoredAddress: currentStoredAddress,
          newProviderAddress: newProviderAddress,
        }
      );

      // Check if current active provider still has accounts
      try {
        const activeProviderAccounts = await this.registry.accountsOf(this.wallet.provider);
        if (this.disposed) return;
        if (this.sessionGeneration(provider) !== session) {
          // This provider's session ended during the probe: the signal
          // describes nothing that still exists, refusal included.
          this.dropRefusal(provider);
          return;
        }

        // The probe is asynchronous too, so check before issuing anything.
        // Every branch below reads the CURRENT evm state, so a switch that
        // went stale during the probe would emit a false disconnect for
        // whoever claimed the namespace, and clear them.
        if (!this.wallet.isCurrent(observation)) {
          // Superseded: this signal's refusal, if noted, no longer describes
          // a session the replay may switch to.
          this.dropRefusal(provider);
          return;
        }

        logger.info("OnAccountsChanged: Checking current provider accounts", {
          activeProvider: this.registry.infoFor(this.wallet.provider).name,
          accountsLength: activeProviderAccounts
            ? activeProviderAccounts.length
            : 0,
          accounts: activeProviderAccounts,
        });

        if (activeProviderAccounts && activeProviderAccounts.length > 0) {
          // Check if the new provider has a different address - this indicates a real wallet switch
          if (
            newProviderAddress &&
            currentStoredAddress &&
            newProviderAddress !== currentStoredAddress
          ) {
            logger.info(
              "OnAccountsChanged: Different address detected, switching providers despite current provider having accounts",
              {
                activeProvider: this.registry.infoFor(this.wallet.provider).name,
                eventProvider: this.registry.infoFor(provider).name,
                currentAddress: currentStoredAddress,
                newAddress: newProviderAddress,
                reason: PROVIDER_SWITCH_REASONS.ADDRESS_MISMATCH,
              }
            );

            // Emit disconnect for the old provider if tracking is enabled
            if (this.deps.isAutocaptureEnabled("disconnect")) {
              await this.deps.disconnect({
                chainId: this.wallet.evmChainId,
                address: this.wallet.evmAddress,
              });
              // Torn down during the emission: nothing below may run.
              if (this.disposed) return;
            } else {
              logger.debug("OnAccountsChanged: Disconnect event skipped during provider switch (autocapture.disconnect: false)");
              // Still clear state even if not tracking the event
              this.wallet.clear('evm');
            }

            if (!this.wallet.isCurrent(observation)) {
              // Superseded: this signal's refusal, if noted, no longer describes
              // a session the replay may switch to.
              this.dropRefusal(provider);
              return;
            }

            // Clear state and let the new provider become active
            this.wallet.clearProvider();
          } else {
            // Ignored: the active wallet has accounts and this signal's
            // address is the same, or the active address is unknown (a
            // discovered wallet whose identity an opt-out purged; a
            // registered one is re-learned before this point). THIS
            // provider's session is not adopted; it stays pending without
            // its refusal marker, so it is not probed again on every page
            // hit while the active wallet stands, and is adopted once that
            // wallet is gone. A live signal is ignored here in exactly the
            // same way, so the replay changes nothing about who is active.
            // While SUPPRESSED this is the refusal itself, not a verdict:
            // the marker stands for the replay that runs once suppression
            // ends.
            if (!this.deps.isTrackingSuppressed()) {
              this.dropRefusal(provider);
            }
            logger.info(
              "OnAccountsChanged: Current provider still has accounts and same address, ignoring new provider",
              {
                activeProvider: this.registry.infoFor(this.wallet.provider).name,
                eventProvider: this.registry.infoFor(provider).name,
                activeProviderAccountsCount: activeProviderAccounts.length,
                currentAddress: currentStoredAddress,
                newAddress: newProviderAddress,
              }
            );
            return;
          }
        } else {
          logger.info(
            "OnAccountsChanged: Current provider has no accounts, switching to new provider",
            {
              oldProvider: this.registry.infoFor(this.wallet.provider).name,
              newProvider: this.registry.infoFor(provider).name,
              reason: PROVIDER_SWITCH_REASONS.NO_ACCOUNTS,
            }
          );

          // Emit disconnect for the old provider that didn't signal properly if tracking is enabled
          if (this.deps.isAutocaptureEnabled("disconnect")) {
            await this.deps.disconnect({
              chainId: this.wallet.evmChainId,
              address: this.wallet.evmAddress,
            });
            // Torn down during the emission: nothing below may run.
            if (this.disposed) return;
          } else {
            logger.debug("OnAccountsChanged: Disconnect event skipped for old provider (autocapture.disconnect: false)");
            // Still clear state even if not tracking the event
            this.wallet.clear('evm');
          }

          if (!this.wallet.isCurrent(observation)) {
            // Superseded: this signal's refusal, if noted, no longer describes
            // a session the replay may switch to.
            this.dropRefusal(provider);
            return;
          }
        }
      } catch (error) {
        logger.warn(
          "OnAccountsChanged: Could not check current provider accounts, switching to new provider",
          {
            error: error instanceof Error ? error.message : String(error),
            errorType:
              error instanceof Error ? error.constructor.name : typeof error,
            oldProvider: this.wallet.provider
              ? this.registry.infoFor(this.wallet.provider).name
              : "unknown",
            newProvider: this.registry.infoFor(provider).name,
            reason: PROVIDER_SWITCH_REASONS.CHECK_FAILED,
          }
        );

        // If we can't check the current provider, assume it's disconnected
        if (this.deps.isAutocaptureEnabled("disconnect")) {
          await this.deps.disconnect({
            chainId: this.wallet.evmChainId,
            address: this.wallet.evmAddress,
          });
          // Torn down during the emission: nothing below may run.
          if (this.disposed) return;
        } else {
          logger.debug("OnAccountsChanged: Disconnect event skipped for failed provider check (autocapture.disconnect: false)");
          // Still clear state even if not tracking the event
          this.wallet.clear('evm');
        }

        if (!this.wallet.isCurrent(observation)) {
          // Superseded: this signal's refusal, if noted, no longer describes
          // a session the replay may switch to.
          this.dropRefusal(provider);
          return;
        }
      }
    }

    // Set provider if none exists (first connection)
    if (!this.wallet.provider) {
      this.wallet.provider = provider;
    }

    // If both the provider and address are the same, no-op
    if (this.wallet.provider === provider && address === this.wallet.evmAddress) {
      // This session is the one already known; nothing is pending for it.
      this.settleAdoption(provider);
      return;
    }

    // Read the chain from what has already been observed. NO RPC.
    //
    // This path used to call `eth_chainId`, which is the same hazard the
    // request paths had removed: on a transport that serializes - a
    // WalletConnect relay socket - a stalled analytics lookup sits in the
    // wallet's queue ahead of the dapp's next signature. `accountsChanged`
    // fires exactly when a user is about to transact, so it is the worst
    // moment to occupy that queue.
    //
    // A provider that has announced nothing yet reports 0 ("unknown"), which
    // the exclusion gate refuses rather than guessing at.
    const nextChainId = this.registry.resolveChainId(provider);
    const wasDisconnected = !this.wallet.evmAddress;

    // Update state regardless of whether connect *event* tracking is enabled,
    // so disconnect events keep valid address/chainId values. (excludeChains is
    // NOT suppression - it still updates state so currentChainId can gate
    // events.)
    if (this.deps.isTrackingSuppressed()) {
      this.wallet.clearStaleEvmWalletOnSwitchWhileSuppressed(address);
      // Again after the await: suppression may have begun mid-flight.
      this.noteRefusalIfSuppressed(provider);
    } else {
      this.wallet.set('evm', { address, chainId: nextChainId });
      // Adopted unsuppressed, whichever path got here first: a retry for
      // this provider would now be a repeat, not a completion.
      this.settleAdoption(provider);
    }

    // Conditionally emit connect event based on tracking configuration
    const providerInfo = this.registry.infoFor(provider);
    const effectiveChainId = nextChainId || 0;
    
    if (
      this.deps.isAutocaptureEnabled("connect") &&
      this.shouldReportConnect(provider, address)
    ) {
      logger.info(
        "OnAccountsChanged: Detected wallet connection, emitting connect event",
        {
          chainId: nextChainId,
          address,
          wasDisconnected,
          providerName: providerInfo.name,
          rdns: providerInfo.rdns,
          hasChainId: !!nextChainId,
        }
      );

      if (effectiveChainId === 0) {
        logger.info(
          "OnAccountsChanged: Using fallback chainId 0 for connect event"
        );
      }

      this.markConnectReported(provider, address, effectiveChainId);
      this.deps.connect(
        {
          chainId: effectiveChainId,
          address,
        },
        {
          providerName: providerInfo.name,
          rdns: providerInfo.rdns,
        }
      ).catch((error) => {
        logger.error(
          "Failed to track connect event during account change:",
          error
        );
      });
    } else {
      logger.debug(
        "OnAccountsChanged: Connect event skipped (autocapture.connect: false)",
        {
          chainId: nextChainId,
          address,
          providerName: providerInfo.name,
        }
      );
    }
  }

  private registerChainChangedListener(provider: EIP1193Provider): void {
    logger.info("registerChainChangedListener");
    const listener = (...args: unknown[]) =>
      this.onChainChanged(provider, args[0] as string);
    provider.on("chainChanged", listener);
    this.registry.addListener(provider, "chainChanged", listener);
  }

  private async onChainChanged(
    provider: EIP1193Provider,
    chainIdHex: string
  ): Promise<void> {
    // A listener that could not be removed at cleanup (its provider's
    // removeListener threw) still fires; it must not touch a torn-down
    // instance.
    if (this.disposed) return;
    logger.info("onChainChanged", chainIdHex);

    const nextChainId = parseChainId(chainIdHex);

    // Record it for THIS provider regardless of which one is active. This is
    // the only way an autocaptured event from a non-active wallet can learn
    // its chain without putting an RPC on that wallet's transport.
    this.registry.rememberChain(provider, nextChainId);

    // Beyond that, a chain event from a NON-active provider is observation
    // only when chain autocapture is off.
    //
    // This listener is now registered unconditionally, so that a signature can
    // be labelled with its signer's chain. `handleProviderMismatch()` treats a
    // chain event from another wallet as a wallet switch and clears the active
    // wallet's address and chain. That is the established behaviour of the
    // chain feature and stays exactly as it was, but it must not start firing
    // for apps that never asked for chain tracking: a second wallet switching
    // network would silently erase the active wallet's attribution.
    // Observation only when chain autocapture is off, whether or not an
    // active provider has been established yet.
    //
    // `isProviderMismatch()` is false while `_provider` is undefined, which is
    // exactly the state left by restoring a wallet from the active-wallet
    // cookie. A background wallet's `chainChanged` could therefore claim the
    // active slot and overwrite the restored wallet's chain - suppressing
    // allowed events, or letting excluded ones through. The active provider is
    // established by an actual account/connect/request association, not by
    // another wallet changing network.
    if (!this.deps.isAutocaptureEnabled("chain") && provider !== this.wallet.provider) {
      return;
    }

    // Only handle chain changes for the active provider (or if none is set yet)
    // A chain event from a non-active EVM provider is only a wallet switch
    // on the EVM side. While Solana holds the active slot it is background
    // noise: letting it through relabelled the session as EVM with no wallet
    // and wiped the EVM wallet we were tracking, on the strength of a network
    // change in a wallet nobody was using. The chain itself is still
    // recorded above, so a later request through that provider is labelled
    // correctly.
    if (this.isProviderMismatch(provider)) {
      if (this.wallet.activeNamespace === "solana") return;
      this.handleProviderMismatch(provider);
    }

    // Chain changes only matter for connected users
    if (!this.wallet.evmAddress) {
      logger.info(
        "OnChainChanged: No current address, user appears disconnected"
      );
      return Promise.resolve();
    }

    // Set provider if none exists
    if (!this.wallet.provider) {
      this.wallet.provider = provider;
    }

    this.wallet.set('evm', { chainId: nextChainId });
    this.deps.retryDetection();

    try {
      // This is just a chain change since we already confirmed _evmAddress exists
      if (this.deps.isAutocaptureEnabled("chain")) {
        // Awaited, so a failing emission is caught below rather than escaping
        // as an unhandled rejection out of the provider's event listener.
        // `return`ing the promise left the catch here unreachable.
        await this.deps.chain({
          chainId: nextChainId,
          address: this.wallet.evmAddress,
        });
      } else {
        logger.debug("OnChainChanged: Chain event skipped (autocapture.chain: false)", {
          chainId: this.wallet.evmChainId,
          address: this.wallet.evmAddress,
        });
      }
    } catch (error) {
      logger.error("OnChainChanged: Failed to emit chain event:", error);
    }
  }

  /**
   * Record a provider's chain from its `connect` event, and nothing else.
   *
   * Used when connect autocapture is off. `connect` carries `chainId` in its
   * payload, so this needs no RPC - unlike the full handler, which resolves
   * the account.
   */
  private registerConnectChainObserver(provider: EIP1193Provider): void {
    const listener = (...args: unknown[]) => {
      const connection = args[0] as { chainId?: unknown } | undefined;
      if (this.disposed) return;
      if (typeof connection?.chainId !== "string") return;
      this.registry.rememberChain(provider, parseChainId(connection.chainId));
      this.awaitingNewSession.delete(provider);
      // This observer adopts nothing, but a registered provider's connect
      // refused by suppression is still a refused signal: once suppression
      // ends, its replay may switch, as the full handler's would.
      this.noteRefusalIfSuppressed(provider);
    };
    provider.on("connect", listener);
    this.registry.addListener(provider, "connect", listener);
  }

  /**
   * Whether a connect for this wallet still needs reporting.
   *
   * True when nothing has been reported for this provider, or when the account
   * changed. A wallet already reported is not reported again.
   *
   * Deliberately does NOT re-report to correct a chain. When `accountsChanged`
   * wins the race on a provider that exposes no synchronous `chainId`, the
   * connect carries 0 - honestly, since the chain is unknown at that instant -
   * and the `connect` payload that follows knows the real one. Emitting again
   * to relabel would mean two connects for one connection, which is the bug
   * this whole path exists to prevent. That payload still corrects
   * `currentChainId`, so everything after it is attributed properly.
   */
  private shouldReportConnect(
    provider: EIP1193Provider,
    address: Address
  ): boolean {
    const reported = this._announcedConnect.get(provider);
    if (!reported) return true;
    return reported.address.toLowerCase() !== address.toLowerCase();
  }

  /**
   * Record a connect as reported - but only if it will actually be sent.
   *
   * `connect()` passes through `shouldTrack()`, which refuses an unresolvable
   * chain when `tracking.excludeChains` is configured. Marking a refused event
   * as reported would suppress the authoritative one that follows.
   */
  private markConnectReported(
    provider: EIP1193Provider,
    address: Address,
    chainId: number
  ): void {
    if (!this.deps.willTrackEvent(chainId)) return;
    this._announcedConnect.set(provider, { address, chainId });
  }

  private registerConnectListener(provider: EIP1193Provider): void {
    logger.info("registerConnectListener");
    const listener = (...args: unknown[]) => {
      const connection: ConnectInfo = args[0] as ConnectInfo;
      this.onConnected(provider, connection);
    };
    provider.on("connect", listener);
    this.registry.addListener(provider, "connect", listener);
  }

  private registerDisconnectListener(provider: EIP1193Provider): void {
    logger.info("registerDisconnectListener");
    const listener = async (_error?: unknown) => {
      if (this.disposed) return;
      this.reopenAdoption(provider);
      if (this.wallet.provider !== provider) return;
      // As in the accountsChanged disconnect path: the reported connect ends
      // with the connection.
      this._announcedConnect.delete(provider);
      logger.info(
        "OnDisconnect: Wallet disconnect event received, current state:",
        {
          currentAddress: this.wallet.evmAddress,
          currentChainId: this.wallet.evmChainId,
        }
      );


      // Double-check disconnect tracking is enabled (defensive programming)
      // Note: This listener should only be registered if tracking is enabled
      if (this.deps.isAutocaptureEnabled("disconnect")) {
        try {
          // Pass current state explicitly to ensure we have the data for the disconnect event
          await this.deps.disconnect({
            chainId: this.wallet.evmChainId,
            address: this.wallet.evmAddress,
          });
          // Torn down during the emission: nothing below may run.
          if (this.disposed) return;
          // Provider remains tracked to allow for reconnection scenarios
        } catch (e) {
          logger.error("Error during disconnect in disconnect listener", e);
          // Don't untrack if disconnect failed to maintain state consistency
        }
      } else {
        logger.debug("OnDisconnect: Disconnect event skipped (autocapture.disconnect: false)");
        this.wallet.beginDisconnect("evm");
        // Still clear state even if not tracking the event
        this.wallet.clear('evm');
      }
    };
    provider.on("disconnect", listener);
    this.registry.addListener(provider, "disconnect", listener);
  }

  private async onConnected(
    provider: EIP1193Provider,
    connection: ConnectInfo
  ): Promise<void> {
    // A listener that could not be removed at cleanup (its provider's
    // removeListener threw) still fires; it must not touch a torn-down
    // instance.
    if (this.disposed) return;
    logger.info("onConnected", connection);
    // A session signal, and BEFORE the account lookup below: suppression
    // that ends while the lookup is in flight must not lose the refusal.
    this.awaitingNewSession.delete(provider);
    this.noteRefusalIfSuppressed(provider);

    // Taken before any await. A connect handler asks a narrower question
    // than a switch does: not "am I still the newest signal?" but "did the
    // wallet go away after I started?". A newer CONNECT must not silence
    // this one, because the two handlers negotiate which of them reports via
    // the announced-connect record, and suppressing both loses the event.
    const disconnectsBefore = this.wallet.disconnectsSoFar("evm");
    // ...but the STATE write is a different matter. If any newer signal has
    // claimed the namespace while we were resolving the address, the address
    // we hold is stale and must not be written over the newer one. The
    // report can still go ahead: the announced-connect record decides that.
    const stateTicket = this.wallet.currentObservation("evm");

    try {
      if (!connection?.chainId || typeof connection.chainId !== "string")
        return;

      const chainId = parseChainId(connection.chainId);
      // Record it for this provider before anything can bail out below.
      this.registry.rememberChain(provider, chainId);
      const session = this.sessionGeneration(provider);
      const address = await this.registry.addressOf(provider);
      if (this.disposed) return;
      if (this.sessionGeneration(provider) !== session) {
        // Disconnected while the lookup was in flight: a former account
        // arriving now must not record a refusal for an ended session.
        this.dropRefusal(provider);
        return;
      }

      // A newer signal arrived while we were resolving the address. Claiming
      // the namespace now would write this stale view over it, and would make
      // a disconnect still in flight look stale so it skipped its cleanup. A
      // reconnect that started AFTER the disconnect holds a newer ticket and
      // is reported normally.
      if (this.wallet.disconnectsSoFar("evm") !== disconnectsBefore) {
        logger.info(
          "onConnected: The wallet disconnected after this observation began; dropping it"
        );
        this.dropRefusal(provider);
        return;
      }

      // A newer signal on THIS provider has superseded what we captured. An
      // account switch that committed while we were resolving the address is
      // the case: writing A back over B, or reporting a connect for A, would
      // both be wrong. A newer signal on a DIFFERENT provider is not this
      // handler's concern - the announced-connect record still decides who
      // reports - so the check is scoped to the provider whose event this is.
      //
      // Scoped further to a signal that actually MOVED the wallet. A reconnect
      // fires `connect` and `accountsChanged` back to back for the same
      // address; the second supersedes the first's ticket without changing
      // anything, and dropping the connect for that would lose the event.
      const committed = this.wallet.evmAddress;
      const movedElsewhere =
        !!committed &&
        !!address &&
        committed.toLowerCase() !== address.toLowerCase();
      if (
        provider === this.wallet.provider &&
        !this.wallet.isCurrent(stateTicket) &&
        movedElsewhere
      ) {
        logger.info(
          "onConnected: A newer signal from this provider has overtaken this connect observation; dropping it"
        );
        this.dropRefusal(provider);
        return;
      }

      if (chainId && address) {
        // Check if this is a connection event (transition from no address to having an address)
        const wasDisconnected = !this.wallet.evmAddress;
        // Same refusal as the accounts path, and before the active-provider
        // gate: a registered provider that connects while another one is
        // active is not adopted here, and may never signal again.
        this.noteRefusalIfSuppressed(provider);

        // Set provider if none exists
        if (!this.wallet.provider) {
          this.wallet.provider = provider;
        }

        // Only emit connect event for the active provider to avoid duplicates
        // Check if this provider is the currently active one
        const isActiveProvider = this.wallet.provider === provider;

        // Update state from active provider so disconnect events keep valid
        // address/chainId values - except while suppressed, where we must not
        // LEARN identity (only drop a stale EVM wallet on a switch).
        if (isActiveProvider) {
          if (this.deps.isTrackingSuppressed()) {
            this.wallet.clearStaleEvmWalletOnSwitchWhileSuppressed(address);
            // Again after the await: suppression may have begun mid-flight.
            this.noteRefusalIfSuppressed(provider);
          } else {
            this.wallet.set('evm', {
              chainId,
              address: validateAndChecksumAddress(address) || undefined,
            });
            this.settleAdoption(provider);
          }
        }

        // Conditionally emit connect event based on tracking configuration.
        //
        // Both handlers observe one connection, so `shouldReportConnect()`
        // decides which of them reports it. It keys on what was actually
        // REPORTED, not on whether an address is known: an address can be
        // present with no connect ever sent - restored from the active-wallet
        // cookie, or reported with an unresolved chain and then refused by
        // `excludeChains` - and this payload carries the authoritative chain,
        // so it must be able to supersede such a report.
        if (
          isActiveProvider &&
          this.wallet.evmAddress &&
          this.shouldReportConnect(provider, address)
        ) {
          const providerInfo = this.registry.infoFor(provider);
          const effectiveChainId = chainId || 0;

          if (this.deps.isAutocaptureEnabled("connect")) {
            logger.info(
              "OnConnected: Detected wallet connection, emitting connect event",
              {
                chainId,
                wasDisconnected,
                providerName: providerInfo.name,
                rdns: providerInfo.rdns,
                hasChainId: !!chainId,
                isActiveProvider,
              }
            );

            if (effectiveChainId === 0) {
              logger.info(
                "OnConnected: Using fallback chainId 0 for connect event"
              );
            }

            this.markConnectReported(provider, address, effectiveChainId);
            this.deps.connect(
              {
                chainId: effectiveChainId,
                address,
              },
              {
                providerName: providerInfo.name,
                rdns: providerInfo.rdns,
              }
            ).catch((error) => {
              logger.error(
                "Failed to track connect event during provider connection:",
                error
              );
            });
          } else {
            logger.debug(
              "OnConnected: Connect event skipped (autocapture.connect: false)",
              {
                chainId,
                address,
                providerName: providerInfo.name,
              }
            );
          }
        } else if (address && !isActiveProvider) {
          const providerInfo = this.registry.infoFor(provider);
          logger.debug(
            "OnConnected: Skipping connect event for non-active provider",
            {
              chainId,
              providerName: providerInfo.name,
              rdns: providerInfo.rdns,
              isActiveProvider,
              activeProviderInfo: this.wallet.provider
                ? this.registry.infoFor(this.wallet.provider)
                : null,
            }
          );
        }
      }
    } catch (e) {
      logger.error("Error handling connect event", e);
    }
  }

  /** Whether Formo owns provider lifecycle tracking. */
  private tracksDiscovered(): boolean {
    return !this.deps.isWagmiMode();
  }

  async getProviders(): Promise<readonly EIP6963ProviderDetail[]> {
    const store = createStore();
    this.discoveryStore = store;
    let providers = store.getProviders();

    this.unsubscribeDiscovery = store.subscribe((providerDetails) => {
      providers = providerDetails;

      // Process newly added providers with proper deduplication
      const newlyAddedDetails = providerDetails.filter((detail) => {
        const provider = detail?.provider as EIP1193Provider | undefined;
        return provider && !this.registry.isSeen(provider);
      });

      // Add new providers to the array without overwriting existing ones
      for (const detail of newlyAddedDetails) {
        this.registry.add(detail);
      }

      // Track listeners for newly discovered providers only
      const newDetails = providerDetails.filter((detail) => {
        const p = detail?.provider as EIP1193Provider | undefined;
        return !!p && !this.registry.isTracked(p);
      });

      // Wagmi detects only providers added by this announcement.
      const toDetect = this.tracksDiscovered() ? newDetails : newlyAddedDetails;

      if (this.tracksDiscovered() && newDetails.length > 0) {
        this.trackProviders(newDetails);
      }
      if (toDetect.length > 0) {
        // Detect newly discovered wallets (session de-dupes) with error handling
        (async () => {
          try {
            await this.detectWallets(toDetect);
          } catch (e) {
            logger.error("Formo: Failed to detect wallets", e);
          }
        })();
      }

      // Clean up providers that are no longer available. Compared against
      // THIS announcement: the registry's list is historical and append-only,
      // so comparing against it could never find anything missing.
      this.cleanupUnavailableProviders(providerDetails);
    });

    // Fallback to injected provider if no providers are found
    if (providers.length === 0) {
      const injected =
        typeof window !== "undefined" ? window.ethereum : undefined;
      if (injected) {
        // If we have already detected and cached the injected provider, and it's the same instance, return the cached result
        if (
          this.registry.injected &&
          this.registry.injected.provider === injected
        ) {
          // Ensure it's tracked
          if (this.tracksDiscovered() && !this.registry.isTracked(injected)) {
            this.trackEIP1193Provider(injected);
          }
          // Merge with existing providers instead of overwriting
          this.registry.add(this.registry.injected);
          return this.registry.all;
        }

        // Re-check if the injected provider is already tracked just before tracking
        if (this.tracksDiscovered() && !this.registry.isTracked(injected)) {
          this.trackEIP1193Provider(injected);
        }

        // Create a mock EIP6963ProviderDetail for the injected provider
        const injectedProviderInfo = detectInjectedProviderInfo(injected);
        const injectedDetail: EIP6963ProviderDetail = {
          provider: injected,
          info: injectedProviderInfo,
        };

        // Cache the detected injected provider detail
        this.registry.injected = injectedDetail;

        // Merge with existing providers instead of overwriting
        this.registry.add(injectedDetail);
      }
      return this.registry.all;
    }

    // Initialize providers array with discovered providers, avoiding duplicates
    const uniqueProviders = providers.filter(
      (detail: EIP6963ProviderDetail) => {
        const provider = detail?.provider as EIP1193Provider | undefined;
        return provider && !this.registry.isSeen(provider);
      }
    );

    // Add to seen providers and instances, ensuring no duplicates in _providers
    for (const detail of uniqueProviders) {
      this.registry.add(detail);
    }

    return this.registry.all;
  }

  async detectWallets(
    providers: readonly EIP6963ProviderDetail[]
  ): Promise<void> {
    try {
      for (const eip6963ProviderDetail of providers) {
        await this.deps.detect({
          providerName: eip6963ProviderDetail?.info.name,
          rdns: eip6963ProviderDetail?.info.rdns,
        });
      }
    } catch (err) {
      logger.error("Error detect all wallets:", err);
    }
  }

  detectableProviders(): readonly EIP6963ProviderDetail[] {
    const available = new Set<EIP1193Provider>();
    this.discoveryStore?.getProviders().forEach((detail) =>
      available.add(detail.provider as EIP1193Provider)
    );
    const injected =
      typeof window !== "undefined" ? window.ethereum : undefined;
    if (injected) available.add(injected);
    this.externallyRegistered.forEach((provider) => available.add(provider));
    return this.registry.all.filter((detail) =>
      available.has(detail.provider as EIP1193Provider)
    );
  }

  /**
   * Seed a provider's chain from whatever it already exposes synchronously.
   *
   * Most EIP-1193 implementations carry a `chainId` property (MetaMask,
   * WalletConnect, Coinbase). Reading it costs nothing and cannot block.
   *
   * There is deliberately no RPC fallback. An earlier version probed with
   * `eth_chainId` when a provider was first tracked, on the theory that
   * tracking time is off the user's critical path. It is not: a serialized
   * transport has ONE queue, so a stalled probe sits in front of every later
   * signature and transaction the dapp makes. It could also land out of order
   * - a slow probe response overwriting a newer `chainChanged` - and relabel
   * events onto a chain the wallet had already left.
   *
   * A provider that exposes nothing stays unknown until it emits
   * `chainChanged` or `connect`, and unknown is reported honestly as 0.
   */
  private seedProviderChainFromState(provider: EIP1193Provider): void {
    const raw = (provider as unknown as { chainId?: unknown }).chainId;
    const chainId =
      typeof raw === "string"
        ? parseChainId(raw)
        : typeof raw === "number"
          ? raw
          : undefined;
    this.registry.rememberChain(provider, chainId);
  }

  untrackProvider(provider: EIP1193Provider): void {
    // An untracked provider has nothing left to finish.
    this.settleAdoption(provider);
    try {
      this.registry.removeListeners(provider);

      // Only stop tracking it if the listeners actually came off. "Tracked"
      // means "has our listeners wired up", which is still true when removal
      // threw, and `cleanup()` iterates the tracked set. Forgetting it here
      // regardless is what made a retained listener unreachable: the entry
      // survived but nothing ever looked at it again, so the retry that
      // retention exists for could never happen.
      if (this.registry.attachedEvents(provider).length === 0) {
        this.registry.forgetTracked(provider);
      }

      if (this.wallet.provider === provider) {
        this.wallet.clearProvider();
      }
    } catch (e) {
      logger.warn("Failed to untrack provider", e);
    }
  }

  /**
   * Clean up providers that are no longer available
   * This helps maintain consistent state and prevents memory leaks
   */
  private cleanupUnavailableProviders(
    current: readonly EIP6963ProviderDetail[]
  ): void {
    // Remove providers that are no longer in the current providers list
    const currentProviderInstances = new Set(
      current.map((detail) => detail.provider as EIP1193Provider)
    );

    for (const provider of this.registry.trackedProviders()) {
      // A registered external provider is never announced over EIP-6963;
      // its absence from an announcement list says nothing about it.
      if (this.externallyRegistered.has(provider)) {
        continue;
      }
      if (!currentProviderInstances.has(provider)) {
        logger.info(
          `Cleaning up unavailable provider: ${provider.constructor.name}`
        );
        this.untrackProvider(provider);
      }
    }
  }

  /**
   * Handle provider mismatch by switching to the new provider and invalidating old tokens
   * @param provider The new provider to switch to
   */
  private handleProviderMismatch(provider: EIP1193Provider): void {
    // If this is a different provider, allow the switch
    if (this.wallet.provider) {
      // Clear any provider-specific state when switching
      this.wallet.set('evm', { address: undefined, chainId: undefined, provider });
    } else {
      this.wallet.provider = provider;
    }
  }}
