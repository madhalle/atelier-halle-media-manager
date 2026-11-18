// Errors raised by domain rules and repositories. HTTP mapping lives in the server.
export type DomainErrorCode =
  | "validation"
  | "not_found"
  | "stale_revision"
  | "invalid_state"
  | "duplicate_identity"
  // The platform connection lacks a permission or expired; signing in again fixes it.
  | "reconnect_required";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
