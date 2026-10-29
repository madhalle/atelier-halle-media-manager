// Turning a wall-clock time the user picked into a UTC instant, with explicit
// handling of daylight-saving gaps and overlaps. Uses the built-in Temporal API.
import { DomainError } from "./errors.ts";

export const DEFAULT_TIMEZONE = "America/New_York";

const LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    return Intl.supportedValuesOf("timeZone").includes(tz) || new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone === tz;
  } catch {
    return false;
  }
}

export type LocalResolution =
  | { kind: "ok"; instant: string; offset: string }
  | { kind: "nonexistent"; suggestion: { localTime: string; instant: string; offset: string } }
  | {
      kind: "ambiguous";
      earlier: { instant: string; offset: string };
      later: { instant: string; offset: string };
    };

/**
 * Resolves `localTime` ("YYYY-MM-DDTHH:mm") in `timeZone`.
 * - nonexistent: the clock skips this time (spring forward); a suggestion is given.
 * - ambiguous: the time happens twice (fall back); the caller must choose.
 * Passing `choice` resolves an ambiguous time; nonexistent times are never auto-shifted.
 */
export function resolveLocalTime(localTime: string, timeZone: string, choice?: "earlier" | "later"): LocalResolution {
  if (!LOCAL_PATTERN.test(localTime)) throw new DomainError("validation", "Enter a date and time.");
  if (!isValidTimeZone(timeZone)) throw new DomainError("validation", "Unknown time zone.");
  let plain: Temporal.PlainDateTime;
  try {
    plain = Temporal.PlainDateTime.from(localTime, { overflow: "reject" });
  } catch {
    throw new DomainError("validation", "That date or time doesn't exist.");
  }
  const earlier = plain.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  const later = plain.toZonedDateTime(timeZone, { disambiguation: "later" });
  const describe = (z: Temporal.ZonedDateTime) => ({ instant: z.toInstant().toString(), offset: z.offset });

  if (!earlier.toPlainDateTime().equals(plain)) {
    // In a gap, "later" lands just after the transition at the same elapsed time.
    return {
      kind: "nonexistent",
      suggestion: { localTime: later.toPlainDateTime().toString({ smallestUnit: "minute" }), ...describe(later) },
    };
  }
  if (earlier.epochNanoseconds !== later.epochNanoseconds) {
    if (choice === "earlier") return { kind: "ok", ...describe(earlier) };
    if (choice === "later") return { kind: "ok", ...describe(later) };
    return { kind: "ambiguous", earlier: describe(earlier), later: describe(later) };
  }
  return { kind: "ok", ...describe(earlier) };
}

/** The wall-clock time of `instant` in `timeZone`, as "YYYY-MM-DDTHH:mm". */
export function localTimeOf(instant: string, timeZone: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: "minute" });
}
