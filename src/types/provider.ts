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

export interface WrappedEIP1193Provider extends EIP1193Provider {
  [WRAPPED_REQUEST_REF_SYMBOL]?: WrappedRequestFunction;
}