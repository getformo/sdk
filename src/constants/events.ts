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
  // Profile/label upserts. These ride the same Events API but are routed to the
  // user_profiles / user_labels datasources; the `type` is informational (the
  // destination datasource is determined by the ingest URL).
  PROFILE = "profile",
  LABEL = "label",
}

export enum EventChannel {
  WEB = "web",
  MOBILE = "mobile",
  SERVER = "server",
  SOURCE = "source",
}

export type TEventType = Lowercase<EventType>;
export type TEventChannel = Lowercase<EventChannel>;
