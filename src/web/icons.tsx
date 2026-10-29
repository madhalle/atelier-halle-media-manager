// Simple generic glyphs; the platform name is always also present as text.
import type { Platform } from "./api.ts";

export function PlatformIcon({ platform }: { platform: Platform }) {
  return platform === "instagram" ? (
    <svg className="platform-icon instagram" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.3" cy="6.7" r="1.2" fill="currentColor" />
    </svg>
  ) : (
    <svg className="platform-icon pinterest" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10 18l1.6-7.2M11 7.5h2.2a2.6 2.6 0 010 5.2H11.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
