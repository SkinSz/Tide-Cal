// Shared device-label resolution for sync surfaces (Sync-Errors cards,
// Paired Devices, Devices & sync). Pure and DOM-free so it is unit-testable
// and usable from any module without pulling in the Tauri IPC layer.
//
// DC-28 §4.7 (one label rule, every surface). The sidecar computes each
// paired device's `label` (nickname > announced name > "Device <short id>",
// duplicates disambiguated per list); this module only picks it up:
//   1. "This device" when the id is OUR own device id (P11, the
//      owner-approved precedence)
//   2. the sidecar label of a paired device
//   3. "Device <short id>" — a complete token, never a "..." truncation
//      (TD-032 / P10)
import { SELF_LABEL, shortId } from "../src/domain/device_names.ts";

export { shortId };

/** One paired peer as device_info / list_paired_devices return it (§4.9). */
export interface PairedDeviceEntry {
  device_id: string;
  label: string;
  short_id?: string;
  nickname?: string | null;
  announced_name?: string | null;
}

/** "Device <short id>" fallback for a device with no usable label. */
export function fallbackDeviceLabel(deviceId: string): string {
  return `Device ${shortId(deviceId)}`;
}

/**
 * Resolve a display label for a device id. `paired` is the paired-peers list
 * (from device_info / list_paired_devices); `selfId` is our own device id.
 * Both are optional — resolution degrades to "Device <short id>".
 */
export function resolveDeviceLabel(
  deviceId: string,
  paired?: PairedDeviceEntry[] | null,
  selfId?: string | null,
): string {
  if (selfId && deviceId === selfId) return SELF_LABEL;
  const hit = paired?.find((p) => p.device_id === deviceId);
  if (hit && typeof hit.label === "string" && hit.label.length > 0) return hit.label;
  return fallbackDeviceLabel(deviceId);
}
