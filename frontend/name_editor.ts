// DC-28 §4.4: in-place name editor (input + Save/Cancel, no native dialog),
// shared by the own-name line (Devices & sync) and the nickname Rename of a
// Paired Devices row. Text is set with textContent / value only (§4.8).
// The live check uses the SAME validateName as the sidecar; the sidecar
// still validates on save (this is a hint, not the gate).
import {
  NAME_MAX_CODE_POINTS,
  NAME_MAX_UTF8_BYTES,
  codePointLength,
  utf8Length,
  validateName,
} from "../src/domain/device_names.ts";

/**
 * §4.8: "the field shows the remaining room, not a character count". Room
 * is the tighter of the two limits (code points, UTF-8 bytes), as a share.
 * Pure, for tests.
 */
export function remainingRoomText(value: string): string {
  const v = value.normalize("NFC");
  const used = Math.max(
    codePointLength(v) / NAME_MAX_CODE_POINTS,
    utf8Length(v) / NAME_MAX_UTF8_BYTES,
  );
  if (used > 1) return "Too long";
  return `Room left: ${Math.floor((1 - used) * 100)}%`;
}

/** Live hint for the current input; null when it can be saved. */
export function nameProblem(value: string): string | null {
  const r = validateName(value);
  if (r.ok) return null;
  if (r.rule === "too_many_characters" || r.rule === "too_many_bytes") return "This name is too long.";
  return "This name contains invisible or control characters.";
}

export interface NameEditorOptions {
  initial: string;
  placeholder?: string;
  help: string;
  /** Persist; reject with an Error whose message is shown to the user. */
  save: (value: string) => Promise<void>;
  /** Called after a successful save or a cancel. */
  close: () => void;
}

export function createNameEditor(opts: NameEditorOptions): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "name-editor";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "name-editor-input";
  input.value = opts.initial;
  if (opts.placeholder !== undefined) input.placeholder = opts.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  const room = document.createElement("span");
  room.className = "muted name-editor-room";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const help = document.createElement("div");
  help.className = "muted name-editor-help";
  help.textContent = opts.help;
  const error = document.createElement("div");
  error.className = "muted name-editor-error";
  error.hidden = true;

  const refresh = (): void => {
    room.textContent = remainingRoomText(input.value);
    const problem = nameProblem(input.value);
    error.hidden = problem === null;
    error.textContent = problem ?? "";
    save.disabled = problem !== null;
  };
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !save.disabled) save.click();
    if (ev.key === "Escape") {
      ev.preventDefault();
      cancel.click();
    }
  });
  cancel.addEventListener("click", () => opts.close());
  save.addEventListener("click", () => {
    save.disabled = true;
    cancel.disabled = true;
    void opts.save(input.value).then(
      () => opts.close(),
      (err: unknown) => {
        save.disabled = false;
        cancel.disabled = false;
        error.hidden = false;
        error.textContent = plainError(err);
      },
    );
  });
  box.append(input, room, save, cancel, help, error);
  refresh();
  return box;
}

/** The sentence part of an IPC error ("Error: x" / "ERR_X: x" -> "x"). */
export function plainError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error:\s*/, "").replace(/^ERR_[A-Z_]+:\s*/, "");
}
