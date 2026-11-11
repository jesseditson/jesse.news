import type { Carrier } from "@archival/carrier";

const TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_ASSET_BYTES = 10_000_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-type, content-length, x-final-url",
};

interface Unfurl {
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

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200, cache = "public, max-age=900"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
}

function publicURL(raw: string | null): URL {
  if (!raw) throw new HttpError(400, "missing url");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "not a url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "only http(s) urls");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":")
  ) {
    throw new HttpError(400, "private hosts are not unfurled");
  }
  url.hash = "";
  return url;
}


async function get(url: URL, accept: string, userAgent: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept, "accept-language": "en;q=1, *;q=0.5", "user-agent": userAgent },
    });
    if (!response.ok) throw new HttpError(502, `upstream responded ${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(504, controller.signal.aborted ? "upstream timed out" : "upstream unreachable");
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, limit: number, stopAt?: RegExp): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new TextDecoder();
  let tail = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      if (stopAt) break;
      throw new HttpError(413, "too large");
    }
    if (stopAt) {
      tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
      if (stopAt.test(tail)) {
        await reader.cancel();
        break;
      }
    }
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•",
  copy: "©", reg: "®", trade: "™", eacute: "é", egrave: "è", aacute: "á", oacute: "ó", uuml: "ü",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const clean = (value: string | undefined) =>
  value ? decodeEntities(value).replace(/\s+/g, " ").trim() : "";

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  const body = tag.replace(/^<\w+/, "");
  while ((match = pattern.exec(body))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function charsetOf(contentType: string | null, head: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (fromHeader || fromMeta || "utf-8").toLowerCase();
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const sniff = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  try {
    return new TextDecoder(charsetOf(contentType, sniff)).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function pickIcon(links: Record<string, string>[], base: URL): string {
  const scored = links
    .filter((l) => {
      const rels = (l.rel || "").toLowerCase().split(/\s+/);
      return !!l.href && rels.some((r) => r === "icon" || r.startsWith("apple-touch-icon"));
    })
    .map((l) => {
      const rel = (l.rel || "").toLowerCase();
      const size = Math.max(0, ...(l.sizes || "").split(/\s+/).map((s) => parseInt(s, 10) || 0));
      let score = size || 32;
      if (rel.includes("apple-touch-icon")) score = Math.max(score, 180);
      if ((l.type || "").includes("svg") || /\.svg(\?|$)/i.test(l.href)) score = 150;
      if (score > 256) score = 256 - (score - 256) / 100;
      return { href: l.href, score };
    })
    .sort((a, b) => b.score - a.score);
  try {
    return new URL(scored[0]?.href || "/favicon.ico", base).toString();
  } catch {
    return new URL("/favicon.ico", base).toString();
  }
}

function absolute(value: string, base: URL): string {
  if (!value) return "";
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

// "Post Title — Site Name" → "Post Title", when the tail names the site.
function trimSiteSuffix(title: string, siteName: string, domain: string): string {
  const stem = squash(domain.split(".")[0] || "");
  const site = squash(siteName);
  const match = /^(.{3,}?)\s+[—–|·-]\s+([^—–|·]+)$/.exec(title);
  if (!match) return title;
  const tail = squash(match[2]);
  return tail && (tail === site || (stem.length > 3 && tail.includes(stem))) ? match[1].trim() : title;
}

function parse(html: string, base: URL): Unfurl {
  const head = html.slice(0, (/<\/head\s*>/i.exec(html)?.index ?? Math.min(html.length, 600_000)) + 7);
  const meta: Record<string, string> = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const a = attributes(tag);
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  const links = (head.match(/<link\b[^>]*>/gi) || []).map(attributes);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const domain = base.hostname.replace(/^www\./, "");
  const number = (v: string | undefined) => {
    const n = parseInt(v || "", 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const siteName = clean(meta["og:site_name"] || meta["application-name"] || meta["apple-mobile-web-app-title"]) || domain;

  return {
    url: base.toString(),
    title: trimSiteSuffix(clean(meta["og:title"] || meta["twitter:title"] || title), siteName, domain),
    description: clean(meta["og:description"] || meta["twitter:description"] || meta["description"]),
    site_name: siteName,
    domain,
    type: clean(meta["og:type"]),
    theme_color: /^#[0-9a-f]{3,8}$/i.test(clean(meta["theme-color"])) ? clean(meta["theme-color"]) : "",
    image: absolute(
      clean(meta["og:image:secure_url"] || meta["og:image"] || meta["og:image:url"] || meta["twitter:image"] || meta["twitter:image:src"]),
      base
    ),
    image_alt: clean(meta["og:image:alt"] || meta["twitter:image:alt"]),
    image_width: number(meta["og:image:width"]),
    image_height: number(meta["og:image:height"]),
    favicon: pickIcon(links, base),
  };
}

async function unfurl(target: URL, userAgent: string): Promise<Unfurl> {
  const response = await get(target, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", userAgent);
  const finalURL = publicURL(response.url || target.toString());
  const type = response.headers.get("content-type") || "";
  if (!/html|xml/i.test(type)) {
    const domain = finalURL.hostname.replace(/^www\./, "");
    const isImage = type.startsWith("image/");
    return {
      url: finalURL.toString(), title: decodeURIComponent(finalURL.pathname.split("/").pop() || domain),
      description: "", site_name: domain, domain, type: isImage ? "image" : "file", theme_color: "",
      image: isImage ? finalURL.toString() : "", image_alt: "", image_width: null, image_height: null,
      favicon: new URL("/favicon.ico", finalURL).toString(),
    };
  }
  const bytes = await readCapped(response, MAX_HTML_BYTES, /<\/head\s*>/i);
  return parse(decode(bytes, type), finalURL);
}

async function proxyAsset(target: URL, userAgent: string): Promise<Response> {
  const response = await get(target, "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8", userAgent);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const looksLikeIcon = /\.ico(\?|$)/i.test(target.pathname);
  if (!type.startsWith("image/") && !(looksLikeIcon && type === "application/octet-stream")) {
    throw new HttpError(415, "not an image");
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_ASSET_BYTES) throw new HttpError(413, "too large");
  const body = await readCapped(response, MAX_ASSET_BYTES);
  return new Response(body, {
    headers: {
      ...CORS,
      "content-type": type.startsWith("image/") ? type : "image/x-icon",
      "cache-control": "public, max-age=86400",
      "x-final-url": response.url || target.toString(),
      "x-content-type-options": "nosniff",
    },
  });
}

const carrier: Carrier = async (params, _body, _objects, site) => {
  const userAgent = `Mozilla/5.0 (compatible; LinkPreview/1.0${site.url ? `; +${site.url}` : ""})`;
  try {
    if (params.has("asset")) return await proxyAsset(publicURL(params.get("asset")), userAgent);
    return json(await unfurl(publicURL(params.get("url")), userAgent));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "unfurl failed";
    return json({ error: message }, status, "no-store");
  }
};

export default carrier;
