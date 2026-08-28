import { logger } from "../logger";
import { isUserRejectionError } from "../provider";
import { parseChainId } from "../utils/chain";
import { validateAndChecksumAddress } from "../utils/address";
import {
  Address,
  ChainID,
  EIP1193Provider,
  IFormoEventProperties,
  RequestArguments,
  RPCError,
  SignatureStatus,
  TransactionStatus,
  WrappedEIP1193Provider,
  WrappedRequestFunction,
  WRAPPED_REQUEST_SYMBOL,
  WRAPPED_REQUEST_REF_SYMBOL,
  WRAPPED_REQUEST_OWNER_SYMBOL,
} from "../types";
import { WalletStateStore } from "../wallet/WalletStateStore";
import { EvmProviderRegistry } from "./EvmProviderRegistry";
import { AutocaptureEventType } from "../tracking/TrackingPolicy";
import {
  readBatchId,
  readBatchStatusCode,
  batchCallOutcome,
  batchReceiptForCall,
  BatchStatusResult,
} from "./batch";

/**
 * Decode a hex-encoded `personal_sign` message.
 *
 * Deliberately not `Buffer.from(hex, "hex")`. `Buffer` is a Node global with
 * no polyfill in this bundle, so in a browser that line threw and the
 * signature event was dropped with it - silently, which is the worst way for
 * analytics to fail. `TextDecoder` is available everywhere this SDK runs, and
 * `TextEncoder` is already used elsewhere in the queue.
 *
 * Malformed input decodes to as much as can be read rather than throwing: a
 * message we cannot fully read is still worth reporting the signature for.
 */
function hexToUtf8(hex: string): string {
  const clean = typeof hex === "string" && hex.startsWith("0x") ? hex.slice(2) : hex;
  if (typeof clean !== "string" || clean.length === 0) return "";
  const byteCount = Math.floor(clean.length / 2);
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    const byte = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return new TextDecoder().decode(bytes.subarray(0, i));
    bytes[i] = byte;
  }
  return new TextDecoder().decode(bytes);
}

/** What the request tracker needs from the SDK that owns it. */
export interface EvmRequestTrackerDeps {
  isAutocaptureEnabled(eventType: AutocaptureEventType): boolean;
  /**
   * Hybrid-capture dedup: true when a PENDING wagmi mutation already covers
   * this request, so the mutation handler owns the capture. TanStack sets a
   * mutation pending BEFORE its mutationFn issues the wallet call, so a
   * hook-driven request always matches; an imperative one never does.
   */
  shouldSkipRequestCapture?(method: string, params: unknown[]): boolean;
  signature(
    params: {
      status: SignatureStatus;
      chainId?: ChainID;
      address: Address;
      message: string;
    },
    properties?: IFormoEventProperties
  ): Promise<void>;
  transaction(
    params: {
      status: TransactionStatus;
      chainId: ChainID;
      address: Address;
      data?: string;
      to?: string;
      value?: string;
      transactionHash?: string;
      function_name?: string;
      function_args?: Record<string, unknown>;
    },
    properties?: IFormoEventProperties
  ): Promise<void>;
}

/**
 * Autocapture for signatures and transactions, by wrapping a provider's
 * `request`.
 *
 * The wrapper is deliberately thin: it observes the call the dapp was already
 * making and never issues one of its own. That rule is why the chain a
 * request ran on is read from `eth_chainId` calls the app makes, rather than
 * probed - an SDK-issued lookup on a serialising transport can wedge the
 * user's wallet, which is never an acceptable price for a label.
 */
/**
 * Providers with a dispatch already on the synchronous call stack.
 *
 * A page can end up with LAYERED Formo wrappers: another library wraps our
 * wrapper, the SDK rebuilds, and the new instance wraps the outer function
 * because the marker is not on it. Both layers route to the same newest
 * live tracker, which would instrument one user request twice. Every
 * dispatch issues its underlying request synchronously (deliberately -
 * the wallet call always goes out first), so an inner shim reached during
 * that window belongs to the SAME user request and passes straight
 * through.
 */
const dispatchInFlight = new WeakSet<object>();

export class EvmRequestTracker {
  /**
   * Timers for receipt and batch-status polling.
   *
   * A poll re-arms for up to thirty seconds, so a torn-down instance would
   * otherwise keep asking a wallet about transactions nobody is listening
   * for, and hold the process open for the whole window. That is the same
   * shape as the batch timer that hung the test suite in #338.
   */
  private polls = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly wallet: WalletStateStore,
    private readonly registry: EvmProviderRegistry,
    private readonly deps: EvmRequestTrackerDeps
  ) {}

  /** Stop every poll in flight. Terminal, like the event queue's close(). */
  cleanup(): void {
    this.disposed = true;
    this.polls.forEach((timer) => clearTimeout(timer));
    this.polls.clear();
    // Remove this instance from every provider's owner list. The lists
    // live on LONG-LIVED provider objects; leaving disposed trackers in
    // them retains each old instance's whole object graph across rebuilds,
    // growing without bound under HMR.
    this.wrappedProviders.forEach((provider) => {
      const owners = (provider as unknown as Record<symbol, unknown>)[
        WRAPPED_REQUEST_OWNER_SYMBOL
      ] as EvmRequestTracker[] | undefined;
      if (Array.isArray(owners)) {
        const idx = owners.indexOf(this);
        if (idx !== -1) owners.splice(idx, 1);
      }
    });
    this.wrappedProviders.clear();
  }

  /** Providers whose owner list includes this instance; pruned on cleanup. */
  private wrappedProviders = new Set<EIP1193Provider>();

  /** Re-arm a poll, unless this tracker has been torn down. */
  private schedulePoll(fn: () => void, delayMs: number): void {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.polls.delete(timer);
      fn();
    }, delayMs);
    this.polls.add(timer);
  }

  /**
   * Wrap a provider's `request`. Returns whether the wrapper is installed:
   * a caller that marks the provider as tracked on a false return would
   * never retry it, and every signature and transaction from that wallet
   * would be missed for the rest of the session.
   */
  /** Monotonic creation stamp; owner precedence is decided by it. */
  private static nextCreationSeq = 0;
  readonly creationSeq = EvmRequestTracker.nextCreationSeq++;

  /**
   * Put this tracker into an owner list at its CREATION-ORDER position.
   * Registration can arrive out of order - an older instance's async wrap
   * kick may resolve after a newer instance's - and dispatch picks from
   * the END of the list, so append-on-registration would let resolution
   * order decide which instance owns capture. Creation order is what the
   * newest-live contract promises.
   */
  private insertBySeniority(owners: EvmRequestTracker[]): void {
    const idx = owners.indexOf(this);
    if (idx !== -1) owners.splice(idx, 1);
    const insertAt = owners.findIndex((o) => o.creationSeq > this.creationSeq);
    if (insertAt === -1) owners.push(this);
    else owners.splice(insertAt, 0, this);
  }

  registerRequestListeners(provider: EIP1193Provider): boolean {
    logger.info("registerRequestListeners");
    if (!provider) {
      logger.error(
        "Provider not found for request (signature, transaction) tracking"
      );
      return false;
    }

    // Already wrapped: take OWNERSHIP rather than skipping. The wrapper
    // survives an SDK rebuild and closes over the instance that installed
    // it, whose queue is closed after cleanup - "skip" made the rebuilt
    // instance report success while every request-derived event died in
    // the dead instance's queue. The wrapper reads the owner slot per call.
    const currentRequest = provider.request as WrappedRequestFunction;
    if (this.registry.isWrapped(provider, currentRequest)) {
      const owners = (provider as unknown as Record<symbol, unknown>)[
        WRAPPED_REQUEST_OWNER_SYMBOL
      ] as EvmRequestTracker[] | undefined;
      if (!Array.isArray(owners)) {
        // A wrapper without its owner list cannot be taken over, and
        // claiming success would silence every request event.
        logger.warn("wrapped without owner list; cannot rebind");
        return false;
      }
      this.insertBySeniority(owners);
      this.wrappedProviders.add(provider);
      logger.info(
        "Provider already wrapped; rebinding the wrapper to this instance."
      );
      return true;
    }

    const request = provider.request.bind(provider);

    const wrappedRequest: WrappedRequestFunction = async <T>({
      method,
      params,
    }: RequestArguments): Promise<T | null | undefined> => {
      // Route to the newest LIVE registrant. `this` here is whichever
      // instance installed the wrapper, which after an SDK rebuild is a
      // torn-down instance with a closed queue. Same body, different deps.
      const owners = (provider as unknown as Record<symbol, unknown>)[
        WRAPPED_REQUEST_OWNER_SYMBOL
      ] as EvmRequestTracker[] | undefined;
      if (dispatchInFlight.has(provider)) {
        // An outer Formo wrapper is already instrumenting this very
        // request; this layer only forwards.
        return request({ method, params }) as Promise<T | null | undefined>;
      }
      const liveOwner = Array.isArray(owners)
        ? [...owners].reverse().find((o) => !o.disposed)
        : undefined;
      dispatchInFlight.add(provider);
      try {
        return (liveOwner ?? this).dispatchWrappedRequest<T>(
          { method, params },
          provider,
          request
        );
      } finally {
        // Cleared as soon as the dispatch call RETURNS its promise: the
        // underlying request has been issued synchronously by then, so
        // the window covers exactly the nested layers of this one call
        // and never a concurrent request.
        dispatchInFlight.delete(provider);
      }
    };
    try {
      // MERGE with any existing list rather than overwriting: a wallet that
      // replaced `request` forces a re-wrap, and discarding the prior list
      // would drop other live instances from ownership - the newest-live
      // fallback then has nobody to fall back to.
      const slot = provider as unknown as Record<symbol, unknown>;
      const prior = slot[WRAPPED_REQUEST_OWNER_SYMBOL];
      const owners: EvmRequestTracker[] = Array.isArray(prior) ? prior : [];
      this.insertBySeniority(owners);
      if (!Array.isArray(prior)) {
        slot[WRAPPED_REQUEST_OWNER_SYMBOL] = owners;
      }
      this.wrappedProviders.add(provider);
    } catch {
      /* frozen provider: the request write below fails too and aborts */
    }
    return this.installWrappedRequest(provider, wrappedRequest);
  }

  /** Install the wrapper function onto the provider; separated so the
   * routing shim above stays small. */
  private installWrappedRequest(
    provider: EIP1193Provider,
    wrappedRequest: WrappedRequestFunction
  ): boolean {
    // Mark the wrapper so we can detect if request is replaced externally and keep a reference on provider
    wrappedRequest[WRAPPED_REQUEST_SYMBOL] = true;

    // Both writes go inside the try. A frozen or non-extensible provider
    // throws on the symbol assignment just as readily as on `request`, and
    // that one used to sit outside the guard, so an unwrappable provider
    // aborted registration instead of being skipped.
    try {
      (provider as WrappedEIP1193Provider)[WRAPPED_REQUEST_REF_SYMBOL] =
        wrappedRequest;
      provider.request = wrappedRequest;
      // Read back: an accessor or Proxy can ACCEPT the assignment without
      // installing it, and success here is a promise that capture works.
      if (provider.request !== wrappedRequest) {
        logger.warn("request assignment swallowed; not wrapped");
        return false;
      }
      return true;
    } catch (e) {
      logger.warn("Failed to wrap provider.request; skipping", e);
      return false;
    }
  }

  /**
   * The wrapper body proper: everything a request observation does, run
   * against THIS instance's registry, wallet state, and event queue. Kept
   * as a method so a surviving wrapper installed by a previous SDK
   * instance can hand calls to the current one.
   */
  private async dispatchWrappedRequest<T>(
    { method, params }: RequestArguments,
    provider: EIP1193Provider,
    request: (args: RequestArguments) => Promise<unknown>
  ): Promise<T | null | undefined> {
      // Learn the chain from a call the APP was making anyway.
      //
      // A standards-compliant provider need not expose a synchronous `chainId`
      // property, and if it connected before the SDK initialised, its
      // `connect` event is never replayed. Such a provider stayed unknown -
      // reported as chain 0, and with `excludeChains` configured its events
      // were dropped even on an allowed chain. This adds no request of its
      // own; it only reads the answer to one the dapp already sent.
      if (method === "eth_chainId") {
        // Snapshot rather than advance. Advancing at request time meant a
        // second lookup that went on to FAIL still invalidated the first
        // one's perfectly good answer, leaving the provider unknown.
        // `rememberProviderChain()` advances it when an observation is
        // actually accepted.
        const generation = this.registry.chainGeneration(provider);
        return request({ method, params }).then((result) => {
          // A `chainChanged` for THIS provider may have landed while this was
          // in flight. It is newer by definition, so it must not be
          // overwritten by this answer.
          if (
            generation === (this.registry.chainGeneration(provider)) &&
            typeof result === "string"
          ) {
            this.registry.rememberChain(provider, parseChainId(result));
          }
          return result as T;
        });
      }

      // Handle Signatures
      if (
        Array.isArray(params) &&
        ["eth_signTypedData_v4", "personal_sign"].includes(method)
      ) {
        if (!this.deps.isAutocaptureEnabled("signature")) {
          logger.debug(`Signature event skipped (autocapture.signature: false)`, { method });
          return request({ method, params }) as Promise<T | null | undefined>;
        }
        if (this.deps.shouldSkipRequestCapture?.(method, params)) {
          // A pending wagmi mutation owns this capture.
          return request({ method, params }) as Promise<T | null | undefined>;
        }
        // Issue the wallet call FIRST, before the chain lookup is even
        // started. Not awaiting our own lookup is not enough: a provider that
        // serializes RPC over a single transport - WalletConnect's relay
        // socket above all, which is exactly the transport this path exists to
        // support - would queue the signing request behind an `eth_chainId`
        // that is already in flight, so a stalled lookup would hold the wallet
        // prompt closed anyway. The SDK-side timeout cannot help there: it
        // releases our promise, not the provider's queue.
        const responsePromise = request({ method, params }) as Promise<T>;
        // Attach a no-op handler now so a rejection arriving before the await
        // below is never reported as unhandled. The real handling is there.
        responsePromise.catch(() => undefined);

        // One synchronous snapshot for the whole lifecycle of this call, taken
        // before the wallet can change anything. No RPC: see
        // resolveChainIdForProvider. Attribution likewise: two connectors can
        // share one provider, and a switch while the prompt is open must not
        // split one signature between two wallet names.
        const capturedChainId = this.registry.resolveChainId(provider);
        const attribution = this.attributionFor(provider);
        // Fire-and-forget tracking
        (async () => {
          try {
            await this.deps.signature({
              status: SignatureStatus.REQUESTED,
              ...this.buildSignatureEventPayload(
                method,
                params,
                undefined,
                capturedChainId,
                provider
              ),
            }, attribution);
          } catch (e) {
            logger.error("Formo: Failed to track signature request", e);
          }
        })();

        try {
          const response = await responsePromise;
          // Track signature confirmation only for truthy responses
          if (response) {
            (async () => {
              try {
                    await this.deps.signature({
                  status: SignatureStatus.CONFIRMED,
                  ...this.buildSignatureEventPayload(
                    method,
                    params,
                    response,
                    capturedChainId,
                    provider
                  ),
                }, attribution);
              } catch (e) {
                logger.error(
                  "Formo: Failed to track signature confirmation",
                  e
                );
              }
            })();
          }
          return response;
        } catch (error) {
          const rpcError = error as RPCError;
          if (isUserRejectionError(rpcError)) {
            // Use the already cast rpcError to avoid duplication
            (async () => {
              try {
                await this.deps.signature({
                  status: SignatureStatus.REJECTED,
                  ...this.buildSignatureEventPayload(
                    method,
                    params,
                    undefined,
                    capturedChainId,
                    provider
                  ),
                }, attribution);
              } catch (e) {
                logger.error("Formo: Failed to track signature rejection", e);
              }
            })();
          }
          throw error;
        }
      }

      // Handle EIP-5792 batched calls.
      //
      // Smart accounts send through `wallet_sendCalls` rather than
      // `eth_sendTransaction`, and until now the SDK understood only the
      // latter: those transactions were not captured at all, silently. That
      // is the same failure shape as the missing-connect bug that started
      // this work - nothing errors, the data is simply absent.
      if (method === "wallet_sendCalls" && Array.isArray(params) && params[0]) {
        return this.trackBatchedCalls(
          provider,
          request,
          params as unknown[]
        ) as Promise<T>;
      }

      // Handle Transactions
      if (
        Array.isArray(params) &&
        method === "eth_sendTransaction" &&
        params[0]
      ) {
        if (!this.deps.isAutocaptureEnabled("transaction")) {
          logger.debug(`Transaction event skipped (autocapture.transaction: false)`, { method });
          return request({ method, params }) as Promise<T | null | undefined>;
        }
        if (this.deps.shouldSkipRequestCapture?.(method, params)) {
          // A pending wagmi mutation owns this capture.
          return request({ method, params }) as Promise<T | null | undefined>;
        }
        // Issue the wallet call FIRST, for the same reason as the signature
        // path above: a provider that serializes RPC would otherwise queue the
        // transaction behind our `eth_chainId`.
        const txPromise = request({ method, params }) as Promise<string>;
        txPromise.catch(() => undefined);

        // One snapshot for the whole lifecycle of this call. Resolving per
        // status would let a network switch made while the prompt is open
        // split STARTED and BROADCASTED across different chains. The same
        // holds for the wallet name, receipt included.
        const txChainId = this.registry.resolveChainId(provider);
        const attribution = this.attributionFor(provider);

        (async () => {
          try {
            const payload = await this.buildTransactionEventPayload(
              params,
              provider,
              txChainId
            );
            await this.deps.transaction({ status: TransactionStatus.STARTED, ...payload }, attribution);
          } catch (e) {
            logger.error("Formo: Failed to track transaction start", e);
          }
        })();

        try {
          const transactionHash = await txPromise;

          (async () => {
            try {
              const payload = await this.buildTransactionEventPayload(
                params,
                provider,
                txChainId
              );
              await this.deps.transaction({
                status: TransactionStatus.BROADCASTED,
                ...payload,
                transactionHash,
              }, attribution);

              // Start async polling for transaction receipt
              this.pollTransactionReceipt(provider, transactionHash, payload, attribution);
            } catch (e) {
              logger.error("Formo: Failed to track transaction broadcast", e);
            }
          })();

          return transactionHash as unknown as T;
        } catch (error) {
          const rpcError = error as RPCError;
          if (isUserRejectionError(rpcError)) {
            // Use the already cast rpcError to avoid duplication
            (async () => {
              try {
                const payload = await this.buildTransactionEventPayload(
                  params,
                  provider,
                  txChainId
                );
                await this.deps.transaction({
                  status: TransactionStatus.REJECTED,
                  ...payload,
                }, attribution);
              } catch (e) {
                logger.error("Formo: Failed to track transaction rejection", e);
              }
            })();
          }
          throw error;
        }
      }

      return request({ method, params }) as Promise<T | null | undefined>;
  }

  /**
   * Wallet attribution for request-derived events.
   *
   * Resolved through the registry at the START of each request and held
   * for that request's whole lifecycle, receipt included. Reading it per
   * status let a connector switch (two connectors sharing one provider) or
   * a session change made while a prompt was open split one operation
   * between two wallet names. Still live across requests: a WalletConnect
   * session names its actual signer ("MetaMask Wallet", "Ledger Live") -
   * the live-test rows had provider_name EMPTY on every signature and
   * transaction, which made per-wallet activity unanswerable in the
   * warehouse.
   */
  private attributionFor(provider: EIP1193Provider): IFormoEventProperties {
    const info = this.registry.infoFor(provider);
    return { providerName: info.name, rdns: info.rdns };
  }

  private buildSignatureEventPayload(
    method: string,
    params: unknown[],
    // Intentionally not read. Kept for positional call-site arity.
    _response?: unknown,
    chainId?: number,
    provider?: EIP1193Provider
  ) {
    const rawAddress =
      method === "personal_sign"
        ? (params[1] as Address)
        : (params[0] as Address);

    const validAddress = validateAndChecksumAddress(rawAddress);
    if (!validAddress) {
      throw new Error(`Invalid address in signature payload: ${rawAddress}`);
    }

    const effectiveChainId = chainId ?? this.wallet.evmChainId ?? undefined;
    // Only the active provider may write central wallet state - see the same
    // guard in buildTransactionEventPayload.
    if (!provider || provider === this.wallet.provider || !this.wallet.provider) {
      this.wallet.backfill(validAddress, effectiveChainId, provider);
    }

    const basePayload = {
      chainId: effectiveChainId,
      address: validAddress,
    };

    if (method === "personal_sign") {
      return {
        ...basePayload,
        message: hexToUtf8(params[0] as string),
      };
    }

    // eth_signTypedData*: params[1] is the full EIP-712 struct.
    return {
      ...basePayload,
      message: params[1] as string,
    };
  }

  private async buildTransactionEventPayload(
    params: unknown[],
    provider?: EIP1193Provider,
    /**
     * Chain resolved once for this request's whole lifecycle. Passing it keeps
     * every status of one transaction on the same chain even if the user
     * switches network while the wallet prompt is open.
     */
    capturedChainId?: number
  ) {
    const { data, from, to, value } = params[0] as {
      data: string;
      from: string;
      to: string;
      value: string;
    };

    const validAddress = validateAndChecksumAddress(from);
    if (!validAddress) {
      throw new Error(`Invalid address in transaction payload: ${from}`);
    }

    const chainId =
      capturedChainId ?? this.registry.resolveChainId(provider);
    // Only the ACTIVE provider may write central wallet state. A request from
    // a second, non-active wallet would otherwise overwrite the active
    // provider's address and chain, and every later request through the active
    // provider would then trust the other wallet's chain - persistent
    // mis-attribution, and a way around `excludeChains`.
    if (!provider || provider === this.wallet.provider || !this.wallet.provider) {
      this.wallet.backfill(validAddress, chainId, provider);
    }

    return {
      chainId,
      data,
      address: validAddress,
      to,
      value,
    };
  }

  /**
   * Polls for transaction receipt and emits tx.status = CONFIRMED or REVERTED.
   */
  private async pollTransactionReceipt(
    provider: EIP1193Provider,
    transactionHash: string,
    payload: any,
    // Snapshot from the broadcast: a connector or session change during
    // the poll window must not relabel the receipt.
    attribution: IFormoEventProperties,
    maxAttempts = 10,
    intervalMs = 3000
  ) {
    let attempts = 0;
    if (!provider) return;
    type Receipt = { status: string | number } | null;
    const poll = async () => {
      if (this.disposed) return;
      try {
        const receipt = (await provider.request({
          method: "eth_getTransactionReceipt",
          params: [transactionHash],
        })) as Receipt;
        if (receipt) {
          // status: 1 = success, 0 = reverted
          if (receipt.status === "0x1" || receipt.status === 1) {
            this.deps
              .transaction({
                status: TransactionStatus.CONFIRMED,
                ...payload,
                transactionHash,
              }, attribution)
              .catch((e) =>
                logger.error("Formo: Failed to track transaction confirmation", e)
              );
            return;
          } else if (receipt.status === "0x0" || receipt.status === 0) {
            this.deps
              .transaction({
                status: TransactionStatus.REVERTED,
                ...payload,
                transactionHash,
              }, attribution)
              .catch((e) =>
                logger.error("Formo: Failed to track transaction revert", e)
              );
            return;
          }
        }
      } catch (e) {
        logger.error("Error polling transaction receipt", e);
      }
      attempts++;
      if (attempts < maxAttempts) this.schedulePoll(poll, intervalMs);
    };
    poll();
  }
  /**
   * One `transaction` event per call in an EIP-5792 batch.
   *
   * The CALL is the unit of attribution: each has its own target, calldata,
   * and value, and folding a batch into one event would misattribute revenue
   * and per-contract activity for every app that adopts smart accounts. How
   * many on-chain transactions a batch becomes depends on execution - an
   * atomic batch lands as ONE transaction, a non-atomic fallback as several -
   * so on-chain volume is `count(distinct transaction_hash)`, wallet actions
   * `count(distinct batch_id)`, never the event count. Each call is reported
   * on its own, carrying the batch id so the calls reassemble downstream.
   *
   * Status is per BATCH, because that is what `wallet_getCallsStatus` reports.
   * When it resolves, every call in the batch moves together, except where
   * per-call receipts say otherwise on a non-atomic batch.
   */
  private async trackBatchedCalls(
    provider: EIP1193Provider,
    request: (args: RequestArguments) => Promise<unknown>,
    params: unknown[]
  ): Promise<unknown> {
    if (!this.deps.isAutocaptureEnabled("transaction")) {
      logger.debug("Transaction event skipped (autocapture.transaction: false)", {
        method: "wallet_sendCalls",
      });
      return request({ method: "wallet_sendCalls", params });
    }
    if (this.deps.shouldSkipRequestCapture?.("wallet_sendCalls", params)) {
      // A pending wagmi sendCalls mutation owns this capture.
      return request({ method: "wallet_sendCalls", params });
    }

    // Issue the wallet call FIRST, for the same reason as every other path
    // here: a provider that serialises RPC would otherwise queue the user's
    // batch behind our own bookkeeping.
    const sendPromise = request({ method: "wallet_sendCalls", params });
    sendPromise.catch(() => undefined);

    const batch = params[0] as {
      from?: string;
      chainId?: string;
      calls?: Array<{ to?: string; data?: string; value?: string }>;
    };
    const calls = Array.isArray(batch?.calls) ? batch.calls : [];

    // The request names its own chain. Prefer it over what we know about the
    // provider: a batch can be sent to a chain the wallet is not sitting on.
    const declared =
      typeof batch?.chainId === "string" ? parseChainId(batch.chainId) : undefined;
    const chainId = declared || this.registry.resolveChainId(provider);

    const address = validateAndChecksumAddress(batch?.from ?? "");
    if (!address) {
      // Nothing can be attributed without a sender, and inventing one would
      // be worse than reporting nothing. The user's call still goes through.
      logger.warn("Formo: wallet_sendCalls has no valid `from`; not tracking", {
        from: batch?.from,
      });
      return sendPromise;
    }

    if (calls.length === 0) {
      logger.debug("Formo: wallet_sendCalls carried no calls");
      return sendPromise;
    }

    // Only the ACTIVE provider may write central wallet state, for the same
    // reason as the single-transaction path: a second wallet would otherwise
    // overwrite the active provider's address and chain.
    if (!provider || provider === this.wallet.provider || !this.wallet.provider) {
      this.wallet.backfill(address, chainId, provider);
    }

    const attribution = this.attributionFor(provider);
    const payloads = calls.map((call, index) => ({
      chainId,
      address,
      to: call?.to,
      value: call?.value,
      data: call?.data,
      properties: {
        batch_size: calls.length,
        batch_index: index,
        ...attribution,
      } as IFormoEventProperties,
    }));

    // STARTED carries no batch id: the wallet has not issued one yet, exactly
    // as `eth_sendTransaction` has no hash at this point. Position within the
    // batch is known, and is what groups these until the id arrives.
    for (const p of payloads) {
      const { properties, ...rest } = p;
      this.deps
        .transaction({ status: TransactionStatus.STARTED, ...rest }, properties)
        .catch((e) => logger.error("Formo: Failed to track batch call start", e));
    }

    try {
      const result = await sendPromise;
      const batchId = readBatchId(result);

      for (const p of payloads) {
        const { properties, ...rest } = p;
        this.deps
          .transaction(
            { status: TransactionStatus.BROADCASTED, ...rest },
            { ...properties, ...(batchId ? { batch_id: batchId } : {}) }
          )
          .catch((e) =>
            logger.error("Formo: Failed to track batch call broadcast", e)
          );
      }

      if (batchId) this.pollBatchStatus(provider, batchId, payloads);
      return result;
    } catch (error) {
      const rpcError = error as RPCError;
      if (isUserRejectionError(rpcError)) {
        // One rejection dismisses the whole prompt, so every call in it is
        // rejected. Reporting only the first would undercount.
        for (const p of payloads) {
          const { properties, ...rest } = p;
          this.deps
            .transaction({ status: TransactionStatus.REJECTED, ...rest }, properties)
            .catch((e) =>
              logger.error("Formo: Failed to track batch call rejection", e)
            );
        }
      }
      throw error;
    }
  }

  /**
   * Resolve a batch through `wallet_getCallsStatus`.
   *
   * The status codes are EIP-5792's: 100 pending, 200 confirmed, 400 failed
   * before landing, 500 reverted, 600 partially reverted. Anything below 200
   * means keep waiting.
   *
   * A per-call receipt wins over the batch verdict where one exists, which is
   * what makes a partially reverted non-atomic batch report honestly instead
   * of marking every call with the batch's worst outcome.
   */
  private async pollBatchStatus(
    provider: EIP1193Provider,
    batchId: string,
    payloads: Array<{
      chainId: number;
      address: Address;
      to?: string;
      value?: string;
      data?: string;
      properties: IFormoEventProperties;
    }>,
    maxAttempts = 10,
    intervalMs = 3000
  ): Promise<void> {
    if (!provider) return;
    let attempts = 0;
    const poll = async () => {
      if (this.disposed) return;
      try {
        const res = (await provider.request({
          method: "wallet_getCallsStatus",
          params: [batchId],
        })) as BatchStatusResult;

        const code = readBatchStatusCode(res);
        if (code !== undefined && code >= 200) {
          payloads.forEach((p, index) => {
            // Atomic-aware: one receipt covering the whole batch reaches
            // every call, hash included, not just call 0.
            const receipt = batchReceiptForCall(res, index, payloads.length);
            const outcome = batchCallOutcome(code, receipt);
            // 600 means SOME calls reverted, so a call with no receipt of its
            // own has not been decided. Reporting it either way would invent
            // a result; leaving it unsettled is the honest answer.
            if (outcome === undefined) return;
            const { properties, ...rest } = p;
            this.deps
              .transaction(
                {
                  status: outcome,
                  ...rest,
                  ...(receipt?.transactionHash
                    ? { transactionHash: receipt.transactionHash }
                    : {}),
                },
                { ...properties, batch_id: batchId }
              )
              .catch((e) =>
                logger.error("Formo: Failed to track batch call outcome", e)
              );
          });
          return;
        }
      } catch (e) {
        logger.error("Error polling batch call status", e);
      }
      attempts++;
      if (attempts < maxAttempts) this.schedulePoll(poll, intervalMs);
    };
    poll();
  }
}
