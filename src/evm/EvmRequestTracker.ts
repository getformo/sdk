import { logger } from "../logger";
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
} from "../types";
import { WalletStateStore } from "../wallet/WalletStateStore";
import { EvmProviderRegistry } from "./EvmProviderRegistry";
import { AutocaptureEventType } from "../tracking/TrackingPolicy";

/** What the request tracker needs from the SDK that owns it. */
export interface EvmRequestTrackerDeps {
  isAutocaptureEnabled(eventType: AutocaptureEventType): boolean;
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
export class EvmRequestTracker {
  constructor(
    private readonly wallet: WalletStateStore,
    private readonly registry: EvmProviderRegistry,
    private readonly deps: EvmRequestTrackerDeps
  ) {}

  registerRequestListeners(provider: EIP1193Provider): void {
    logger.info("registerRequestListeners");
    if (!provider) {
      logger.error(
        "Provider not found for request (signature, transaction) tracking"
      );
      return;
    }

    // Check if the provider is already wrapped with our SDK's wrapper
    const currentRequest = provider.request as WrappedRequestFunction;
    if (this.registry.isWrapped(provider, currentRequest)) {
      logger.info(
        "Provider already wrapped with our SDK; skipping request wrapping."
      );
      return;
    }

    const request = provider.request.bind(provider);

    const wrappedRequest: WrappedRequestFunction = async <T>({
      method,
      params,
    }: RequestArguments): Promise<T | null | undefined> => {
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
          return request({ method, params });
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
        // resolveChainIdForProvider.
        const capturedChainId = this.registry.resolveChainId(provider);
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
            });
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
                });
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
          if (rpcError?.code === 4001) {
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
                });
              } catch (e) {
                logger.error("Formo: Failed to track signature rejection", e);
              }
            })();
          }
          throw error;
        }
      }

      // Handle Transactions
      // TODO: Support eip5792.xyz calls
      if (
        Array.isArray(params) &&
        method === "eth_sendTransaction" &&
        params[0]
      ) {
        if (!this.deps.isAutocaptureEnabled("transaction")) {
          logger.debug(`Transaction event skipped (autocapture.transaction: false)`, { method });
          return request({ method, params });
        }
        // Issue the wallet call FIRST, for the same reason as the signature
        // path above: a provider that serializes RPC would otherwise queue the
        // transaction behind our `eth_chainId`.
        const txPromise = request({ method, params }) as Promise<string>;
        txPromise.catch(() => undefined);

        // One snapshot for the whole lifecycle of this call. Resolving per
        // status would let a network switch made while the prompt is open
        // split STARTED and BROADCASTED across different chains.
        const txChainId = this.registry.resolveChainId(provider);

        (async () => {
          try {
            const payload = await this.buildTransactionEventPayload(
              params,
              provider,
              txChainId
            );
            await this.deps.transaction({ status: TransactionStatus.STARTED, ...payload });
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
              });

              // Start async polling for transaction receipt
              this.pollTransactionReceipt(provider, transactionHash, payload);
            } catch (e) {
              logger.error("Formo: Failed to track transaction broadcast", e);
            }
          })();

          return transactionHash as unknown as T;
        } catch (error) {
          const rpcError = error as RPCError;
          if (rpcError?.code === 4001) {
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
                });
              } catch (e) {
                logger.error("Formo: Failed to track transaction rejection", e);
              }
            })();
          }
          throw error;
        }
      }

      return request({ method, params });
    };
    // Mark the wrapper so we can detect if request is replaced externally and keep a reference on provider
    wrappedRequest[WRAPPED_REQUEST_SYMBOL] = true;
    (provider as WrappedEIP1193Provider)[WRAPPED_REQUEST_REF_SYMBOL] =
      wrappedRequest;

    try {
      // Attempt to assign the wrapped request function (rely on try-catch for mutability errors)
      provider.request = wrappedRequest;
    } catch (e) {
      logger.warn("Failed to wrap provider.request; skipping", e);
    }
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
      const message = Buffer.from(
        (params[0] as string).slice(2),
        "hex"
      ).toString("utf8");
      return {
        ...basePayload,
        message,
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
    maxAttempts = 10,
    intervalMs = 3000
  ) {
    let attempts = 0;
    if (!provider) return;
    type Receipt = { status: string | number } | null;
    const poll = async () => {
      try {
        const receipt = (await provider.request({
          method: "eth_getTransactionReceipt",
          params: [transactionHash],
        })) as Receipt;
        if (receipt) {
          // status: 1 = success, 0 = reverted
          if (receipt.status === "0x1" || receipt.status === 1) {
            this.deps.transaction({
              status: TransactionStatus.CONFIRMED,
              ...payload,
              transactionHash,
            });
            return;
          } else if (receipt.status === "0x0" || receipt.status === 0) {
            this.deps.transaction({
              status: TransactionStatus.REVERTED,
              ...payload,
              transactionHash,
            });
            return;
          }
        }
      } catch (e) {
        logger.error("Error polling transaction receipt", e);
      }
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(poll, intervalMs);
      }
    };
    poll();
  }}
