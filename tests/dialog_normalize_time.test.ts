// Smoke-test regression (2026-09-03): the dialog time fields are plain text
// inputs (WebKitGTK locale bug) — normalizeTime guards free-typed entry.
import { describe, expect, it } from "vitest";
import { normalizeTime } from "../frontend/dialog.ts";

describe("normalizeTime (24h text time input)", () => {
  it("passes strict 24h values through unchanged", () => {
    expect(normalizeTime("09:15")).toBe("09:15");
    expect(normalizeTime("23:59")).toBe("23:59");
    expect(normalizeTime("00:00")).toBe("00:00");
  });

  it("normalizes loose typing", () => {
    expect(normalizeTime("9")).toBe("09:00");
    expect(normalizeTime("9:5")).toBe("09:05");
    expect(normalizeTime("0930")).toBe("09:30");
    expect(normalizeTime("9.30")).toBe("09:30");
    expect(normalizeTime("9h30")).toBe("09:30");
    expect(normalizeTime(" 21:05 ")).toBe("21:05");
  });

  it("accepts 12h suffixed entry and converts", () => {
    expect(normalizeTime("9:30pm")).toBe("21:30");
    expect(normalizeTime("12am")).toBe("00:00");
    expect(normalizeTime("12pm")).toBe("12:00");
    expect(normalizeTime("11:00am")).toBe("11:00");
  });

  it("rejects garbage and out-of-range values", () => {
    expect(normalizeTime("")).toBeNull();
    expect(normalizeTime("abc")).toBeNull();
    expect(normalizeTime("24:00")).toBeNull();
    expect(normalizeTime("9:75")).toBeNull();
    expect(normalizeTime("9:30:15")).toBeNull();
    expect(normalizeTime("-1:00")).toBeNull();
  });
});
