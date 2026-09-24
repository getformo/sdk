export enum EventType {
  PAGE = "page",
  IDENTIFY = "identify",
  DETECT = "detect",
  CONNECT = "connect",
  DISCONNECT = "disconnect",
  CHAIN = "chain",
  SIGNATURE = "signature",
  TRANSACTION = "transaction",
  TRACK = "track",
  REPLAY = "replay",
}

export enum EventChannel {
  WEB = "web",
  MOBILE = "mobile",
  SERVER = "server",
  SOURCE = "source",
}

export type TEventType = Lowercase<EventType>;
export type TEventChannel = Lowercase<EventChannel>;
