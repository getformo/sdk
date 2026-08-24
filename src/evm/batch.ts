import { TransactionStatus } from "../types/events";

/**
 * EIP-5792 batch settlement, shared by both capture paths.
 *
 * The EIP-1193 request wrapper (`EvmRequestTracker`) and the wagmi cache
 * observer (`WagmiEventHandler`) each see a batch through a different
 * transport, but a settled batch means the same thing in both. Keeping the
 * outcome rules in one place is what stops the two paths from drifting into
 * reporting the same batch differently depending on how the app happened to
 * integrate the SDK.
 */

/** A settled batch as `wallet_getCallsStatus` (or viem's wrapper) reports it. */
export type BatchStatusResult = {
  status?: number | string;
  statusCode?: number;
  atomic?: boolean;
  receipts?: BatchReceipt[];
} | null | undefined;

export type BatchReceipt = {
  status?: string | number;
  transactionHash?: string;
};

/**
 * The batch identifier from a `wallet_sendCalls` result.
 *
 * EIP-5792 settled on `{ id }`, but wallets shipped against the earlier
 * draft return a bare string. Both are accepted so a wallet on either
 * version is still grouped.
 */
export function readBatchId(result: unknown): string | undefined {
  if (typeof result === "string" && result.length > 0) return result;
  if (result && typeof result === "object") {
    const id = (result as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/**
 * The numeric EIP-5792 status code from a settlement result.
 *
 * A wallet answers `wallet_getCallsStatus` with a numeric `status`; viem's
 * `getCallsStatus` renames that to `statusCode` and puts a summary string in
 * `status` instead. Both shapes arrive here depending on the capture path,
 * so read the number wherever it is and never trust the string.
 */
export function readBatchStatusCode(res: BatchStatusResult): number | undefined {
  if (typeof res?.statusCode === "number") return res.statusCode;
  if (typeof res?.status === "number") return res.status;
  return undefined;
}

/**
 * How one call in a settled batch ended.
 *
 * A per-call receipt is authoritative where it exists: that is what makes a
 * partially reverted non-atomic batch report honestly rather than tarring
 * every call with the batch's worst outcome. A receipt whose own status is
 * unreadable falls back to the batch verdict rather than being assumed good.
 *
 * Receipt statuses come in two spellings: raw RPC (`"0x0"`/`"0x1"`, or the
 * numbers) and viem-formatted (`"reverted"`/`"success"`), because the wagmi
 * path sees receipts after viem has normalised them.
 *
 * The codes are EIP-5792's: 200 confirmed, 400 failed BEFORE landing on
 * chain, 500 reverted, 600 partially reverted. 400 is a rejection, not a
 * revert - nothing was mined, so calling it reverted would misreport gas
 * spent and on-chain activity that never happened.
 *
 * Returns undefined when the call cannot be decided, which happens on 600
 * for a call the wallet gave no receipt for.
 */
export function batchCallOutcome(
  code: number,
  receipt?: BatchReceipt
): TransactionStatus | undefined {
  const receiptStatus = receipt?.status;
  if (receiptStatus !== undefined) {
    return receiptStatus === "0x0" ||
      receiptStatus === 0 ||
      receiptStatus === "reverted"
      ? TransactionStatus.REVERTED
      : TransactionStatus.CONFIRMED;
  }
  if (code >= 600) return undefined;
  if (code >= 500) return TransactionStatus.REVERTED;
  if (code >= 400) return TransactionStatus.REJECTED;
  return TransactionStatus.CONFIRMED;
}

/**
 * The receipt that decides call `index`, honouring atomic execution.
 *
 * An atomic batch lands as ONE on-chain transaction, so the wallet returns a
 * single receipt covering every call. Indexing receipts positionally there
 * would hand the shared hash to call 0 and leave its siblings hashless and
 * decided only by the batch verdict. Every call in an atomic batch shares
 * the one receipt - same hash, same fate - which is also what makes
 * `count(distinct transaction_hash)` count on-chain transactions correctly.
 *
 * The wallet's own `atomic` flag is trusted first. Wallets predating that
 * field get a conservative inference: one receipt for several calls on a
 * batch that is NOT partially reverted can only be atomic execution (600
 * explicitly means some calls reverted and others did not, which one shared
 * transaction cannot do).
 */
export function batchReceiptForCall(
  res: BatchStatusResult,
  index: number,
  callCount: number
): BatchReceipt | undefined {
  const receipts = Array.isArray(res?.receipts) ? res.receipts : [];
  const code = readBatchStatusCode(res) ?? 0;
  const atomic =
    res?.atomic === true ||
    (receipts.length === 1 && callCount > 1 && code < 600);
  return atomic ? receipts[0] : receipts[index];
}
