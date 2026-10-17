/**
 * Time-locked transaction utilities (#587, #725).
 *
 * buildTimeLockTransaction fetches the real account sequence from Horizon
 * (or accepts a caller-supplied sequence) and builds a BumpSequence transaction
 * with the requested time bounds, returning unsigned XDR.
 *
 * validateTimeBounds and getTimeLockedTransactionStatus are pure helpers with
 * no network I/O.
 */

import {
  Account,
  Horizon,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Inclusive time bounds for a Stellar transaction.
 * Both fields are Unix timestamps in seconds.
 * maxTime === 0 means no upper bound.
 */
export interface TimeBounds {
  /** Earliest time the transaction is valid (Unix seconds). 0 = no lower bound. */
  minTime: number;
  /** Latest time the transaction is valid (Unix seconds). 0 = no upper bound. */
  maxTime: number;
}

/**
 * Status of a time-locked transaction evaluated against a given timestamp.
 */
export type TimeLockExecutionStatus =
  | "pending"     // current time is before minTime
  | "executable"  // current time is within [minTime, maxTime]
  | "expired"     // current time is after maxTime (and maxTime !== 0)
  | "invalid";    // time bounds are logically invalid (e.g. minTime > maxTime)

/**
 * Options for buildTimeLockTransaction.
 */
export interface TimeLockTransactionOptions {
  timeBounds: TimeBounds;
  /**
   * Pre-fetched sequence number. When supplied, no Horizon round-trip is made.
   * Must be the current on-chain sequence (TransactionBuilder increments by 1).
   */
  sequence?: string;
  /** Override the transaction fee in stroops. Defaults to BASE_FEE. */
  fee?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidTimeBounds(timeBounds: TimeBounds): boolean {
  if (timeBounds.minTime < 0 || timeBounds.maxTime < 0) return false;
  if (timeBounds.maxTime !== 0 && timeBounds.minTime > timeBounds.maxTime) return false;
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate that a TimeBounds object is logically consistent.
 * Returns true when valid, false otherwise.
 */
export function validateTimeBounds(timeBounds: TimeBounds): boolean {
  return isValidTimeBounds(timeBounds);
}

/**
 * Evaluate the execution status of a time-locked transaction at a given moment.
 * Returns one of: "pending" | "executable" | "expired" | "invalid".
 */
export function getTimeLockedTransactionStatus(
  timeBounds: TimeBounds,
  nowSeconds?: number,
): TimeLockExecutionStatus {
  if (!isValidTimeBounds(timeBounds)) return "invalid";

  const now = nowSeconds ?? Date.now() / 1000;

  if (timeBounds.minTime > 0 && now < timeBounds.minTime) return "pending";
  if (timeBounds.maxTime !== 0 && now > timeBounds.maxTime) return "expired";
  return "executable";
}

/**
 * Build an unsigned time-locked transaction XDR.
 *
 * Fetches the real account sequence from Horizon unless `options.sequence`
 * is supplied, avoiding tx_bad_seq on submission.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration.
 * @param sourcePublicKey - G-address of the transaction source account.
 * @param options         - Time bounds, optional pre-fetched sequence, optional fee.
 */
export async function buildTimeLockTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  options: TimeLockTransactionOptions,
): Promise<SorokitResult<string>> {
  const { timeBounds, sequence, fee } = options;

  if (!isValidTimeBounds(timeBounds)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid time bounds: minTime (${timeBounds.minTime}) must not exceed maxTime (${timeBounds.maxTime}) when maxTime is non-zero.`,
    );
  }

  try {
    let sourceAccount: Account;

    if (sequence !== undefined) {
      sourceAccount = new Account(sourcePublicKey, sequence);
    } else {
      const server = new Horizon.Server(horizonUrl);
      const loaded = await server.loadAccount(sourcePublicKey);
      sourceAccount = new Account(sourcePublicKey, loaded.sequenceNumber());
    }

    let builder = new TransactionBuilder(sourceAccount, {
      fee: fee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    }).addOperation(
      Operation.bumpSequence({
        bumpTo: sourceAccount.sequenceNumber(),
      }),
    );

    if (timeBounds.maxTime !== 0) {
      builder = builder.setTimebounds(timeBounds.minTime, timeBounds.maxTime);
    } else if (timeBounds.minTime !== 0) {
      builder = builder.setTimebounds(
        timeBounds.minTime,
        Math.floor(Date.now() / 1000) + DEFAULT_TX_TIMEOUT_SECONDS,
      );
    } else {
      builder = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
    }

    const tx = builder.build();
    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build time-lock transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}
