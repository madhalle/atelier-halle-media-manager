// Errors raised by domain rules and repositories. HTTP mapping lives in the server.
export type DomainErrorCode =
  | "validation"
  | "not_found"
  | "stale_revision"
  | "invalid_state"
  | "duplicate_identity";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
