import type { DateTime } from "@archival/custom-editor-api";
import type { EditorAPI } from "../archival.js";

const pad = (n: number) => String(n).padStart(2, "0");

function offset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

// archival reads "YYYY-MM-DD HH:MM:SS +HHMM".
const toRaw = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset(date)}`;

function fromRaw(raw: string): Date | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(raw.trim());
  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = match;
  if (!zone) return new Date(+y, +mo - 1, +d, +h, +mi, +s);
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (zone === "Z") return new Date(utc);
  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const minutes = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4));
  return new Date(utc - minutes * 60000);
}

const toLocalInput = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

const pretty = (date: Date) =>
  date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

window.ArchivalEditor.onready((injected) => {
  const api = injected as EditorAPI<"Date">;
  const editor = document.getElementById("editor") as HTMLElement;
  const input = document.getElementById("when") as HTMLInputElement;
  const list = document.getElementById("list") as HTMLElement;
  const controls = document.getElementById("controls") as HTMLElement;
  const listMode = api.display === "list";

  editor.classList.remove("list", "inline", "full");
  editor.classList.add(api.display);
  controls.hidden = listMode;
  list.hidden = !listMode;

  let current: Date | null = null;
  let heard = false;

  function render(): void {
    list.textContent = current ? pretty(current) : "";
    if (document.activeElement !== input) input.value = current ? toLocalInput(current) : "";
  }

  function write(date: Date): void {
    current = date;
    api.send({ WriteValue: { raw: toRaw(date) } });
    render();
  }

  // A new post starts with no date; stamp it the moment the composer opens.
  function stampIfEmpty(): void {
    if (!listMode && !current) write(new Date());
  }

  document.getElementById("now")?.addEventListener("click", () => write(new Date()));
  input.addEventListener("change", () => {
    const date = input.value ? new Date(input.value) : null;
    if (date && !Number.isNaN(date.getTime())) write(date);
  });

  api.listen((event) => {
    if (!event || typeof event !== "object" || !("ValueUpdated" in event)) return;
    heard = true;
    const stored = event.ValueUpdated as DateTime | string | undefined;
    const raw = typeof stored === "string" ? stored : stored?.raw;
    current = raw ? fromRaw(raw) : null;
    render();
    stampIfEmpty();
  });

  setTimeout(() => {
    if (!heard) stampIfEmpty();
  }, 1500);

  render();
});
