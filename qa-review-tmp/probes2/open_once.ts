// pkg1-review CHECK B: single-purpose DB opener used as the kill target.
// Prints READY, waits for a "go" line on stdin (so the parent can time SIGKILL
// from a known point), then opens the DB — triggering the v5->v6 migration —
// and prints MIGRATED once openDatabase returns.
import { openDatabase } from "../../src/persistence/database.ts";

const path = process.argv[2]!;
console.log(`READY ${process.pid}`);
if (process.platform !== "win32") process.stdin.resume();
let buf = "";
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString();
  if (buf.includes("go")) {
    const db = openDatabase({ path });
    const v = (db.prepare("SELECT version v FROM schema_version").get() as { v: number }).v;
    console.log(`MIGRATED v=${v}`);
    db.close();
    process.exit(0);
  }
});
