const ENDPOINT = "/carriers/social";
const HANDLE_KEY = "jesse.news:fediverse-handle";
const FAILED = "That didn't go through. Try again in a bit.";

export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private mode: nothing to remember.
    }
  },
};

export class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new RequestError(body.error || FAILED, response.status);
  return body;
}

export async function read<T>(action: string, query: Record<string, string> = {}): Promise<T> {
  const search = new URLSearchParams({ action, ...query });
  return answer<T>(await fetch(`${ENDPOINT}?${search}`));
}

export async function write<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${ENDPOINT}?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return answer<T>(response);
}

export interface Person {
  name: string;
  handle: string | null;
  url: string | null;
  icon: string | null;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export const initials = (name: string) =>
  name
    .replace(/^@/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

export const hue = (name: string) => {
  let total = 0;
  for (let i = 0; i < name.length; i += 1) total = (total * 31 + name.charCodeAt(i)) % 360;
  return total;
};

export function avatar(who: Pick<Person, "name" | "icon">, extra = ""): HTMLElement {
  const node = el("span", `comment-avatar ${extra}`.trim(), initials(who.name));
  node.style.setProperty("--comment-hue", String(hue(who.name)));
  node.setAttribute("aria-hidden", "true");
  if (who.icon?.startsWith("https://")) {
    const image = el("img");
    image.alt = "";
    image.src = who.icon;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    node.append(image);
  }
  return node;
}

export const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

let forms = 0;

interface FediverseFormOptions {
  // The post to open, or null for this site's own account.
  path: string | null;
  summary: string;
  explain: string;
  // What an app user can paste into their app's search instead.
  searchFor: string;
}

// Sends a fediverse user to their own server, opened on this post (or this site's account), to reply, boost or follow from there.
export function fediverseForm({ path, summary, explain, searchFor }: FediverseFormOptions): HTMLElement {
  const n = ++forms;
  const details = el("details", "fediverse");
  details.innerHTML = `
    <summary class="fediverse-summary"></summary>
    <p class="fediverse-explain"></p>
    <form class="fediverse-form" novalidate>
      <label class="visually-hidden" for="fediverse-handle-${n}">Your fediverse handle or server</label>
      <input class="fediverse-handle" id="fediverse-handle-${n}" name="handle" type="text" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="@you@mastodon.social" required>
      <button class="fediverse-go" type="submit">Open on my server</button>
      <p class="fediverse-error" role="alert"></p>
    </form>
    <p class="fediverse-search">
      Using an app? Search it for <code class="fediverse-search-for"></code>
      <button type="button" class="fediverse-copy">Copy</button>
      <span class="fediverse-copied" role="status"></span>
    </p>`;
  details.querySelector(".fediverse-summary")!.textContent = summary;
  details.querySelector(".fediverse-explain")!.textContent = explain;
  details.querySelector(".fediverse-search-for")!.textContent = searchFor;
  const form = details.querySelector<HTMLFormElement>(".fediverse-form")!;
  const input = form.querySelector<HTMLInputElement>(".fediverse-handle")!;
  const button = form.querySelector<HTMLButtonElement>(".fediverse-go")!;
  const error = form.querySelector<HTMLElement>(".fediverse-error")!;
  const copied = details.querySelector<HTMLElement>(".fediverse-copied")!;
  input.value = store.get(HANDLE_KEY) ?? "";

  details.querySelector(".fediverse-copy")!.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(searchFor);
      copied.textContent = "Copied";
      setTimeout(() => (copied.textContent = ""), 1600);
    } catch {
      // No clipboard access: the text is on screen to copy by hand.
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const handle = input.value.trim();
    if (!handle) {
      error.textContent = "Enter your handle, like @you@mastodon.social, or just your server.";
      return;
    }
    button.disabled = true;
    try {
      const { url } = await read<{ url: string }>("interact", { handle, ...(path ? { path } : {}) });
      store.set(HANDLE_KEY, handle);
      window.location.assign(url);
    } catch (thrown) {
      error.textContent = thrown instanceof Error ? thrown.message : FAILED;
      button.disabled = false;
    }
  });
  return details;
}

const KEEP = new Set(["P", "BR", "A", "EM", "STRONG", "I", "B", "U", "S", "DEL", "UL", "OL", "LI", "BLOCKQUOTE", "CODE", "PRE", "SPAN"]);
const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH"]);

// Fediverse posts arrive as HTML from other servers; only plain prose markup is rebuilt, attribute by attribute.
export function cleanHTML(html: string): DocumentFragment {
  const source = new DOMParser().parseFromString(html, "text/html").body;
  const out = document.createDocumentFragment();
  const copy = (from: Node, into: Node) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(document.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (!(child instanceof Element) || DROP.has(child.tagName)) continue;
      if (!KEEP.has(child.tagName)) {
        copy(child, into);
        continue;
      }
      const node = document.createElement(child.tagName.toLowerCase());
      if (node instanceof HTMLAnchorElement) {
        const href = child.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) {
          node.href = href;
          node.rel = "nofollow noopener ugc";
          node.target = "_blank";
        }
      }
      if (node.tagName === "SPAN") {
        const kept = ["invisible", "ellipsis"].filter((name) => child.classList.contains(name));
        if (kept.length) node.className = kept.join(" ");
      }
      copy(child, node);
      into.appendChild(node);
    }
  };
  copy(source, out);
  return out;
}
