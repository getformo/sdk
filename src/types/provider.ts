import EventEmitter from 'events'

export interface RequestArguments {
  method: string
  params?: unknown[] | Record<string, unknown>
}

export interface EIP1193Provider extends EventEmitter {
  request<T>(args: RequestArguments): Promise<T | null | undefined>
  on(eventName: string | symbol, listener: (...args: unknown[]) => void): this
  removeListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this
}

export interface RPCError extends Error {
  code: number;
  data?: unknown;
}

export interface ConnectInfo {
  chainId: string;
}

export const WRAPPED_REQUEST_SYMBOL = Symbol("formoWrappedRequest");

export type WrappedRequestFunction = (<T>(args: RequestArguments) => Promise<T | null | undefined>) & {
  [WRAPPED_REQUEST_SYMBOL]?: boolean;
};

export const WRAPPED_REQUEST_REF_SYMBOL = Symbol("formoWrappedRequestRef");

/**
 * The SDK instance a provider's installed wrapper currently reports to.
 *
 * The wrapper survives an SDK rebuild (nothing restores `provider.request`),
 * and its closure holds the instance that installed it - whose event queue
 * is CLOSED after cleanup. Without this slot, a rebuilt instance saw
 * "already wrapped", reported success, and every request-derived event
 * silently died in the old instance's queue. The wrapper reads this slot on
 * every call and routes to the current owner; re-registration just rebinds
 * it.
 */
export const WRAPPED_REQUEST_OWNER_SYMBOL = Symbol("formoWrappedRequestOwner");

export interface WrappedEIP1193Provider extends EIP1193Provider {
  [WRAPPED_REQUEST_REF_SYMBOL]?: WrappedRequestFunction;
}