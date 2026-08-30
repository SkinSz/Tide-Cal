#!/usr/bin/env node
// Pkg 2 (QA M-1 / BND-01) — phantom-row detection for pre-fix dev databases.
//
// QA SCRIPT, NOT PRODUCT CODE. Run manually against a developer DB:
//
//   node docs/qa/remediation/pkg2-phantom-detect.mjs ~/.local/share/com.tide.app/tide-domain.db
//
// Background: before the Pkg2 fix, update_event with a client-supplied
// input.id silently INSERTED a phantom event row while writing change
// records under the TARGET's entity. Two detectable corruption signatures:
//
//   S1 (phantom row):    an `events` row whose event_id never appears as
//                        entity_id of an event-creation change record
//                        (field_path='event', operation='set').
//   S2 (false record):   event change records whose entity_id has no row in
//                        `events` and no explaining 'remove' tombstone record
//                        — i.e. the log claims updates for a missing row.
//
// Exit code: 0 = clean, 1 = corruption signatures found, 2 = usage error.
import Database from "better-sqlite3";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node pkg2-phantom-detect.mjs <path-to-tide-domain.db>");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });

const createdEntities = new Set(
  db
    .prepare(
      "SELECT DISTINCT entity_id FROM changes WHERE entity_type='event' AND field_path='event' AND operation='set'",
    )
    .all()
    .map((r) => r.entity_id),
);

const rows = db.prepare("SELECT event_id, title, updated_hlc FROM events").all();
const phantomRows = rows.filter((r) => !createdEntities.has(r.event_id));

const allEventEntities = new Set(
  db.prepare("SELECT DISTINCT entity_id FROM changes WHERE entity_type='event'").all().map((r) => r.entity_id),
);
const removedEntities = new Set(
  db
    .prepare("SELECT DISTINCT entity_id FROM changes WHERE entity_type='event' AND operation='remove'")
    .all()
    .map((r) => r.entity_id),
);
const rowIds = new Set(rows.map((r) => r.event_id));
const falseRecords = [...allEventEntities].filter(
  (id) => !rowIds.has(id) && !removedEntities.has(id),
);

console.log(`db:            ${dbPath}`);
console.log(`event rows:    ${rows.length}`);
console.log(`event entities in change log: ${allEventEntities.size}`);
console.log("");
if (phantomRows.length > 0) {
  console.log(`S1 PHANTOM ROWS (${phantomRows.length}) — rows with NO creation change record:`);
  for (const r of phantomRows) {
    console.log(`  ${r.event_id}  title=${JSON.stringify(r.title)}  updated_hlc=${r.updated_hlc}`);
  }
} else {
  console.log("S1: no phantom rows (every event row has a creation record)");
}
console.log("");
if (falseRecords.length > 0) {
  console.log(`S2 FALSE RECORDS (${falseRecords.length}) — change-log entities with no row and no remove record:`);
  for (const id of falseRecords) console.log(`  ${id}`);
} else {
  console.log("S2: no false change records (every logged event entity is a row or a logged removal)");
}

db.close();
process.exit(phantomRows.length > 0 || falseRecords.length > 0 ? 1 : 0);
