const BATCH = 12;

declare global {
  interface DocumentEventMap {
    "feed:cards": CustomEvent<{ cards: HTMLElement[] }>;
  }
}

const parser = new DOMParser();

export async function fetchDocument(url: string): Promise<Document> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return parser.parseFromString(await response.text(), "text/html");
}

function retag(el: Element, tagName: string): void {
  const replacement = document.createElement(tagName);
  for (const attr of el.attributes) replacement.setAttribute(attr.name, attr.value);
  replacement.append(...el.childNodes);
  el.replaceWith(replacement);
}

// Cards fetched from another page carry that page's heading levels.
function normalizeHeadings(card: Element): void {
  card.classList.remove("is-open");
  card.querySelectorAll("h1.link-title").forEach((h) => retag(h, "h2"));
}

function readQueue(doc: Document): string[] {
  try {
    const parsed: unknown = JSON.parse(doc.getElementById("feed-rest")?.textContent || "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function initFeed(): void {
  const found = document.querySelector<HTMLElement>("[data-feed]");
  const status = document.querySelector<HTMLElement>("[data-feed-status]");
  if (!found) return;
  const feed = found;

  let queue: string[] = [];
  let loading = false;
  let failures = 0;

  const present = () =>
    new Set([...feed.querySelectorAll<HTMLElement>(".card[data-path]")].map((c) => c.dataset.path));

  function append(cards: HTMLElement[]): void {
    const seen = present();
    const added: HTMLElement[] = [];
    cards.forEach((card, i) => {
      if (card.dataset.path && seen.has(card.dataset.path)) return;
      added.push(card);
      normalizeHeadings(card);
      card.classList.add("is-new");
      card.style.setProperty("--stagger", String(i));
      card.addEventListener("animationend", () => card.classList.remove("is-new"), { once: true });
      feed.append(card);
    });
    if (added.length) document.dispatchEvent(new CustomEvent("feed:cards", { detail: { cards: added } }));
  }

  function setStatus(text: string): void {
    if (status) status.textContent = text;
  }

  function sentinelVisible(): boolean {
    if (!status) return false;
    return status.getBoundingClientRect().top < window.innerHeight + 1200;
  }

  async function loadMore(): Promise<void> {
    if (loading || !queue.length) return;
    loading = true;
    setStatus("Fetching more cards…");

    const batch = queue.splice(0, BATCH);
    const results = await Promise.allSettled(batch.map((path) => fetchDocument(`/${path}.html`)));
    const cards = results
      .map((r) => (r.status === "fulfilled" ? r.value.querySelector<HTMLElement>("[data-solo] .card") : null))
      .filter((card): card is HTMLElement => card !== null)
      .map((card) => document.adoptNode(card));

    if (!cards.length && results.length) failures += 1;
    append(cards);
    loading = false;

    if (failures > 2) {
      setStatus("Couldn't reach the rest of the cards.");
      return;
    }
    setStatus(queue.length ? "" : "That's every card.");
    if (queue.length && sentinelVisible()) requestAnimationFrame(() => loadMore());
  }

  async function bootstrap(): Promise<void> {
    const source = feed.dataset.feedSource;
    if (source) {
      try {
        const doc = await fetchDocument(source);
        const remote = doc.querySelector("[data-feed]");
        append([...(remote?.children || [])].map((el) => document.adoptNode(el as HTMLElement)));
        queue = readQueue(doc);
      } catch {
        setStatus("");
        return;
      }
    } else {
      queue = readQueue(document);
    }

    if (!queue.length) {
      setStatus(feed.querySelector(".card[data-path]") ? "That's every card." : "");
      return;
    }

    if (status) {
      new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        { rootMargin: "0px 0px 1200px 0px" }
      ).observe(status);
    }
  }

  bootstrap();
}
