// Tide DC-18/DC-23 shared interop helpers. Kept tiny — both modules stay
// independent; only genuinely common predicates live here.

/** True when `tz` is an IANA zone name the runtime can resolve (§3.4/D3). */
export function isIANAZoneGuard(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
