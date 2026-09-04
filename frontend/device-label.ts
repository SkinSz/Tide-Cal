// Shared device-label resolution for sync surfaces (Sync-Errors context line,
// Paired Devices dialog). Pure and DOM-free so it is unit-testable and usable
// from any module without pulling in the Tauri IPC layer.
//
// Precedence (owner-approved UX package, 2026-08-27):
//   1. paired list display_name (human-chosen name wins)
//   2. "This device" when the id is OUR own device id
//   3. truncated id fallback — honest, never invented

export interface PairedDeviceEntry {
  device_id: string;
  display_name: string;
}

/** Truncated device id for display ("dev-f6d77e6c-156…"). */
export function truncatedDeviceId(deviceId: string): string {
  return deviceId.length > 16 ? deviceId.slice(0, 16) + "…" : deviceId;
}

/**
 * Resolve a display label for a device id. `paired` is the paired-peers list
 * (from device_info / list_paired_devices); `selfId` is our own device id.
 * Both are optional — resolution degrades honestly to the truncated id.
 */
export function resolveDeviceLabel(
  deviceId: string,
  paired?: PairedDeviceEntry[] | null,
  selfId?: string | null,
): string {
  const hit = paired?.find((p) => p.device_id === deviceId);
  if (hit && hit.display_name) return hit.display_name;
  if (selfId && deviceId === selfId) return "This device";
  return truncatedDeviceId(deviceId);
}
