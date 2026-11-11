/**
 * Coded protocol/store errors — M1-01.
 *
 * Throw these (never raw driver errors) so the daemon transport (M1-02)
 * can map them to the safe public error shape without leaking internals.
 * Evidence: [DESIGN] (spec §§7, 14 dual-error model).
 */

export type ProtocolErrorCode =
  | "INVALID_TRANSITION"
  | "KILLED_MEMBER"
  | "STALE_GENERATION"
  | "SELF_DEP"
  | "UNKNOWN_DEP"
  | "DAG_CYCLE"
  | "SELF_ACCEPT"
  | "AMBIGUOUS_MENTION"
  | "UNKNOWN_MENTION"
  | "DUPLICATE_NAME"
  | "NOT_FOUND"
  | "LIVE_TURN_ACTIVE"
  | "VALIDATION_FAILED";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: ProtocolErrorCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}
