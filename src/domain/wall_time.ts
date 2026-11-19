// Naive local wall-clock helpers shared by the calendar view and the reminder
// timer, so both derive an occurrence the same way (DC-12 §2.3, DC-22).

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Epoch ms from a 'YYYYMMDD[THHMMSS]' wall-clock id (local time). */
export function msFromWallId(id: string): number {
  const digits = id.replace(/\D/g, "");
  const y = +digits.slice(0, 4);
  const mo = +digits.slice(4, 6);
  const dd = +digits.slice(6, 8);
  const hh = +digits.slice(8, 10) || 0;
  const mi = +digits.slice(10, 12) || 0;
  const ss = +digits.slice(12, 14) || 0;
  return new Date(y, mo - 1, dd, hh, mi, ss, 0).getTime();
}

/** 'YYYY-MM-DDTHH:MM' naive wall clock from epoch ms (SeriesState form). */
export function baseStartWall(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}
