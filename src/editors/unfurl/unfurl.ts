import type { Meta, MetaValue } from "@archival/custom-editor-api";
import type { EditorAPI } from "../archival.js";
import { SITE_URL } from "./config.js";

const CARRIER = `${SITE_URL.replace(/\/+$/, "")}/carriers/unfurl`;
const MAX_IMAGE_WIDTH = 1200;
const KEEP_ORIGINAL_BYTES = 900_000;

// What the unfurl carrier returns.
interface Unfurled {
  url: string;
  title: string;
  description: string;
  site_name: string;
  domain: string;
  type: string;
  theme_color: string;
  image: string;
  image_alt: string;
  image_width: number | null;
  image_height: number | null;
  favicon: string;
}

interface CachedFile {
  url: string;
  sha?: string;
  filename?: string;
  mime?: string;
  width?: number;
  height?: number;
  alt?: string;
  source?: string;
  cached?: boolean;
}

// The link field's value, as stored in the object.
interface LinkValue {
  url?: string;
  title?: string;
  description?: string;
  site_name?: string;
  domain?: string;
  type?: string;
  theme_color?: string;
  fetched_at?: string;
  image?: CachedFile | null;
  favicon?: CachedFile | null;
}

type Plain = string | number | boolean | Plain[] | { [key: string]: Plain | null | undefined };

// Meta values cross into the editor externally tagged: {String: "…"}, {Map: {…}}, ….
function tag(value: Plain): MetaValue {
  if (typeof value === "string") return { String: value };
  if (typeof value === "number") return { Number: value };
  if (typeof value === "boolean") return { Boolean: value };
  if (Array.isArray(value)) return { Array: value.map(tag) };
  return { Map: tagMap(value) };
}

function tagMap(object: { [key: string]: Plain | null | undefined }): Meta {
  const out: Meta = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = tag(value);
  }
  return out;
}

function untag(value: MetaValue): Plain {
  if ("String" in value) return value.String;
  if ("Number" in value) return value.Number;
  if ("Boolean" in value) return value.Boolean;
  if ("DateTime" in value) return value.DateTime.raw;
  if ("Array" in value) return value.Array.map(untag);
  return untagMap(value.Map);
}

function untagMap(map: Meta): { [key: string]: Plain } {
  const out: { [key: string]: Plain } = {};
  for (const [key, value] of Object.entries(map)) out[key] = untag(value);
  return out;
}

// Field values are rendered as Liquid at build time, so text pulled from other
// sites must never contain an opening Liquid delimiter.
const liquidSafe = (text: string | null | undefined) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\{(?=[{%])/g, "{\u200b");

const urlSafe = (url: string) => url.trim().replace(/\{/g, "%7B").replace(/\}/g, "%7D");

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "link";

function normalizeURL(raw: string): string {
  let text = raw.trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) text = `https://${text.replace(/^\/+/, "")}`;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

async function carrierJSON(params: Record<string, string>): Promise<Unfurled> {
  const response = await fetch(`${CARRIER}?${new URLSearchParams(params)}`, { credentials: "omit" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || `preview service responded ${response.status}`);
  return body as Unfurled;
}

async function carrierAsset(url: string): Promise<Blob> {
  const response = await fetch(`${CARRIER}?${new URLSearchParams({ asset: url })}`, { credentials: "omit" });
  if (!response.ok) throw new Error(`asset ${response.status}`);
  return response.blob();
}

function loadImage(blob: Blob): Promise<{ img: HTMLImageElement; release: () => void }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(blob);
    img.onload = () => resolve({ img, release: () => URL.revokeObjectURL(src) });
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error("unreadable image"));
    };
    img.src = src;
  });
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), type, quality)
  );

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

interface Prepared {
  blob: Blob;
  mime: string;
  ext: string;
  width?: number;
  height?: number;
}

async function preparePreview(blob: Blob): Promise<Prepared> {
  const { img, release } = await loadImage(blob);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  try {
    const keep =
      blob.type in EXTENSIONS &&
      blob.type !== "image/avif" &&
      blob.size <= KEEP_ORIGINAL_BYTES &&
      (width <= MAX_IMAGE_WIDTH || blob.type === "image/svg+xml");
    if (keep) return { blob, width, height, mime: blob.type, ext: EXTENSIONS[blob.type] };

    const ratio = Math.min(1, MAX_IMAGE_WIDTH / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fbfaf6";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const encoded = await toBlob(canvas, "image/jpeg", 0.84);
    return { blob: encoded, width: canvas.width, height: canvas.height, mime: "image/jpeg", ext: "jpg" };
  } finally {
    release();
  }
}

async function prepareIcon(blob: Blob): Promise<Prepared> {
  try {
    const { img, release } = await loadImage(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      canvas.getContext("2d")?.drawImage(img, 0, 0, 64, 64);
      return { blob: await toBlob(canvas, "image/png"), mime: "image/png", ext: "png" };
    } finally {
      release();
    }
  } catch {
    const mime = blob.type || "image/x-icon";
    return { blob, mime, ext: EXTENSIONS[mime] || "ico" };
  }
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

window.ArchivalEditor.onready((injected) => {
  const api = injected as EditorAPI<"Meta">;
  const editor = element("editor");
  const form = element<HTMLFormElement>("lookup");
  const input = element<HTMLInputElement>("url");
  const fetchButton = element<HTMLButtonElement>("fetch");
  const refreshButton = element<HTMLButtonElement>("refresh");
  const status = element("status");
  const preview = element("preview");
  const source = element("source");
  const image = element<HTMLImageElement>("image");
  const fields = {
    title: element<HTMLInputElement>("title"),
    description: element<HTMLTextAreaElement>("description"),
    site_name: element<HTMLInputElement>("site_name"),
  };

  let value: LinkValue = {};
  let lastWritten: LinkValue | null = null;
  let busy = false;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  function setStatus(text: string, kind: "" | "error" = ""): void {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function write(next: LinkValue): void {
    value = next;
    clearTimeout(writeTimer);
    if (!value.url) {
      lastWritten = null;
      api.send({ WriteValue: undefined });
      return;
    }
    lastWritten = structuredClone(value);
    api.send({ WriteValue: tagMap(value as { [key: string]: Plain }) });
  }

  function render(): void {
    editor.classList.remove("list", "inline", "full");
    editor.classList.add(api.display);
    const listMode = api.display === "list";
    element("list").hidden = !listMode;
    form.hidden = listMode;
    preview.hidden = listMode || !value.url;
    fetchButton.disabled = busy;
    refreshButton.disabled = busy;

    const favicon = value.favicon?.url;
    for (const id of ["favicon", "list-favicon"]) {
      const icon = element<HTMLImageElement>(id);
      icon.hidden = !favicon;
      if (favicon) icon.src = favicon;
    }
    element("list-title").textContent = value.title || value.url || "No link yet";
    element("list-domain").textContent = value.domain || "";
    source.textContent = value.site_name || value.domain || "";

    if (document.activeElement !== input) input.value = value.url || input.value;
    for (const [key, el] of Object.entries(fields)) {
      if (document.activeElement !== el) el.value = value[key as keyof typeof fields] || "";
    }

    const imageURL = value.image?.url;
    element("image-wrap").hidden = !imageURL;
    if (imageURL) {
      image.src = imageURL;
      image.alt = value.image?.alt || "";
    }
  }

  async function cacheImage(meta: Unfurled): Promise<CachedFile | null> {
    if (!meta.image) return null;
    const fallback: CachedFile = {
      url: urlSafe(meta.image),
      source: urlSafe(meta.image),
      alt: liquidSafe(meta.image_alt),
      cached: false,
    };
    try {
      const prepared = await preparePreview(await carrierAsset(meta.image));
      const uploaded = await api.upload(prepared.blob, {
        filename: `${slug(meta.domain)}-preview.${prepared.ext}`,
        name: clip(liquidSafe(meta.title), 120) || meta.domain,
        mime: prepared.mime,
        display_type: "image",
      });
      return {
        url: uploaded.url,
        sha: uploaded.sha,
        filename: uploaded.filename,
        mime: uploaded.mime || prepared.mime,
        width: prepared.width,
        height: prepared.height,
        alt: liquidSafe(meta.image_alt),
        source: urlSafe(meta.image),
      };
    } catch {
      return fallback;
    }
  }

  async function cacheFavicon(meta: Unfurled): Promise<CachedFile | null> {
    if (!meta.favicon) return null;
    try {
      const prepared = await prepareIcon(await carrierAsset(meta.favicon));
      const uploaded = await api.upload(prepared.blob, {
        filename: `${slug(meta.domain)}-icon.${prepared.ext}`,
        name: `${meta.domain} icon`,
        mime: prepared.mime,
        display_type: "image",
      });
      return {
        url: uploaded.url,
        sha: uploaded.sha,
        filename: uploaded.filename,
        mime: uploaded.mime || prepared.mime,
        source: urlSafe(meta.favicon),
      };
    } catch {
      return null;
    }
  }

  async function lookup(raw: string): Promise<void> {
    const url = normalizeURL(raw);
    if (!url) {
      setStatus("That doesn't look like a web address.", "error");
      return;
    }
    if (busy) return;
    busy = true;
    input.value = url;
    setStatus("Reading the page…");
    render();

    let meta: Unfurled;
    try {
      meta = await carrierJSON({ url });
    } catch (error) {
      busy = false;
      const domain = new URL(url).hostname.replace(/^www\./, "");
      write({ ...value, url: urlSafe(url), domain, fetched_at: new Date().toISOString() });
      const reason = error instanceof Error ? error.message : String(error);
      setStatus(`Couldn't fetch a preview (${reason}). Fill in the details below by hand.`, "error");
      render();
      return;
    }

    setStatus("Saving the preview image…");
    const [cachedImage, favicon] = await Promise.all([cacheImage(meta), cacheFavicon(meta)]);

    write({
      url: urlSafe(meta.url || url),
      title: clip(liquidSafe(meta.title), 300),
      description: clip(liquidSafe(meta.description), 600),
      site_name: clip(liquidSafe(meta.site_name), 120),
      domain: liquidSafe(meta.domain),
      type: liquidSafe(meta.type),
      theme_color: /^#[0-9a-f]{3,8}$/i.test(meta.theme_color || "") ? meta.theme_color : "",
      fetched_at: new Date().toISOString(),
      image: cachedImage,
      favicon,
    });
    busy = false;
    setStatus(
      cachedImage?.cached === false ? "Saved. The image couldn't be copied, so it links to the original." : "Saved."
    );
    render();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    lookup(input.value);
  });

  input.addEventListener("paste", () => setTimeout(() => lookup(input.value), 0));

  refreshButton.addEventListener("click", () => lookup(value.url || input.value));

  element("clear").addEventListener("click", () => {
    input.value = "";
    setStatus("");
    write({});
    render();
  });

  element("drop-image").addEventListener("click", () => {
    const { image: _dropped, ...rest } = value;
    write(rest);
    render();
  });

  for (const [key, el] of Object.entries(fields)) {
    el.addEventListener("input", () => {
      if (!value.url) return;
      value = { ...value, [key]: clip(liquidSafe(el.value), key === "description" ? 600 : 300) };
      clearTimeout(writeTimer);
      writeTimer = setTimeout(() => write(value), 400);
      source.textContent = value.site_name || value.domain || "";
    });
  }

  api.listen((event) => {
    if (!event || typeof event !== "object" || !("ValueUpdated" in event)) return;
    const stored = event.ValueUpdated as Meta | undefined;
    const incoming = (stored ? untagMap(stored) : {}) as LinkValue;
    if (lastWritten && sameValue(incoming, lastWritten)) return;
    value = incoming;
    render();
  });

  render();
});
