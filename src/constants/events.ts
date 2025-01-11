export enum Event {
  IDENTIFY = 'identify',
  PAGE = 'page_hit',
  CONNECT = 'connect',
  DISCONNECT = 'disconnect',
  CHAIN_CHANGED = 'chain_changed',
  SIGNATURE_REQUESTED = 'signature_requested',
  SIGNATURE_CONFIRMED = 'signature_confirmed',
  SIGNATURE_REJECTED = 'signature_rejected',
  TRANSACTION_STARTED = 'transaction_started',
  TRANSACTION_REJECTED = 'transaction_rejected',
  TRANSACTION_BROADCASTED = 'transaction_broadcasted'
}
