import { stopMedia, startMedia } from "./media.js";
import { fetchDocument } from "./feed.js";

const CARD_PATH = /^\/(post\/[^/]+?|contact)(?:\.html)?$/;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;

declare global {
  interface DocumentEventMap {
    "card:open": CustomEvent<{ card: HTMLElement }>;
  }
}

interface ZoomState {
  zoom?: string;
  fromFeed?: boolean;
}

interface Open {
  card: HTMLElement;
  path: string;
  placeholder: HTMLElement | null;
}

function pathFromLocation(): string | null {
  const match = window.location.pathname.match(CARD_PATH);
  return match ? decodeURIComponent(match[1]) : null;
}

function inViewport(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
}

// Transform that maps `to` back onto `from`, for a FLIP animation from `from`.
function invert(from: Box, to: Box, tilt = "0deg"): string {
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy}) rotate(${tilt})`;
}

const tiltOf = (el: Element) => getComputedStyle(el).getPropertyValue("--tilt").trim() || "0deg";

export function initZoom({ prefersReducedMotion }: { prefersReducedMotion: boolean }) {
  const root = document.documentElement;
  const siteName =
    document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content || document.title;
  const homeTitle = siteName;

  const zoom = document.createElement("div");
  zoom.className = "zoom";
  zoom.hidden = true;
  zoom.setAttribute("role", "dialog");
  zoom.setAttribute("aria-modal", "true");
  const scrim = document.createElement("div");
  scrim.className = "zoom-scrim";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "zoom-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  zoom.append(scrim, closeButton);
  document.body.append(zoom);

  let current: Open | null = null;
  let animating = false;

  const duration = (ms: number) => (prefersReducedMotion ? 1 : ms);
  const zoomState = (): ZoomState => (history.state as ZoomState | null) ?? {};

  function setInert(value: boolean): void {
    for (const el of document.body.children) {
      if (el !== zoom && !el.matches(".vhs, .rain, .backdrop, .flash, script")) {
        (el as HTMLElement).inert = value;
      }
    }
  }

  function cardFor(path: string): HTMLElement | null {
    const selector = `.card[data-path="${CSS.escape(path)}"]`;
    return (
      document.querySelector<HTMLElement>(`[data-feed] ${selector}`) ||
      document.querySelector<HTMLElement>(`[data-solo] ${selector}`)
    );
  }

  async function open(card: HTMLElement, { push = true, animate = true } = {}): Promise<void> {
    if (animating) return;
    if (current) await close({ restoreURL: false });
    animating = true;

    const path = card.dataset.path || "";
    const tilt = tiltOf(card);
    const first = card.getBoundingClientRect();
    const inFeed = !!card.closest("[data-feed]");

    let placeholder: HTMLElement | null = null;
    if (inFeed) {
      placeholder = document.createElement("div");
      placeholder.className = "card-placeholder";
      placeholder.style.height = `${card.offsetHeight}px`;
      card.before(placeholder);
    }

    zoom.hidden = false;
    zoom.append(card);
    card.classList.add("is-open");
    root.classList.add("is-zoomed");
    setInert(true);
    zoom.scrollTop = 0;
    current = { card, path, placeholder };

    if (push) {
      history.pushState({ zoom: path, fromFeed: true } satisfies ZoomState, "", `/${path}.html`);
    }
    document.title = `${card.dataset.title || ""} — ${siteName}`;

    const last = card.getBoundingClientRect();
    const fadeIn = { duration: duration(380), easing: "ease-out" };
    const animations = [
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], fadeIn),
      closeButton.animate([{ opacity: 0 }, { opacity: 1 }], fadeIn),
    ];
    if (animate && inViewport(first)) {
      animations.push(
        card.animate([{ transform: invert(first, last, tilt) }, { transform: "none" }], {
          duration: duration(520),
          easing: EASE,
        })
      );
    } else if (animate) {
      animations.push(
        card.animate(
          [{ opacity: 0, transform: "translateY(1.5rem) scale(0.96)" }, { opacity: 1, transform: "none" }],
          { duration: duration(420), easing: EASE }
        )
      );
    }

    closeButton.focus({ preventScroll: true });
    startMedia(card);
    document.dispatchEvent(new CustomEvent("card:open", { detail: { card } }));
    await Promise.allSettled(animations.map((a) => a.finished));
    animating = false;
  }

  async function close({ restoreURL = true } = {}): Promise<void> {
    if (!current || animating) return;
    animating = true;
    const { card, placeholder, path } = current;
    stopMedia(card);

    const twin = placeholder
      ? null
      : document.querySelector<HTMLElement>(`[data-feed] .card[data-path="${CSS.escape(path)}"]`);
    const target = placeholder || twin;
    const first = card.getBoundingClientRect();
    const targetRect = target?.getBoundingClientRect();
    const tilt = tiltOf(target || card);

    let flight: Animation;
    if (targetRect && inViewport(targetRect)) {
      flight = card.animate([{ transform: "none" }, { transform: invert(targetRect, first, tilt) }], {
        duration: duration(440),
        easing: EASE,
        fill: "forwards",
      });
      if (twin) twin.style.visibility = "hidden";
    } else {
      flight = card.animate(
        [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(1rem) scale(0.96)" }],
        { duration: duration(300), easing: "ease-in", fill: "forwards" }
      );
    }
    const fade = scrim.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: duration(380),
      easing: "ease-in",
      fill: "forwards",
    });
    closeButton.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration(200), fill: "forwards" });

    await Promise.allSettled([flight.finished, fade.finished]);

    card.classList.remove("is-open");
    if (placeholder) {
      placeholder.replaceWith(card);
    } else {
      card.remove();
      if (twin) twin.style.visibility = "";
    }
    for (const el of [card, scrim, closeButton]) el.getAnimations().forEach((a) => a.cancel());

    zoom.hidden = true;
    root.classList.remove("is-zoomed");
    setInert(false);
    current = null;
    animating = false;

    const returnTo = (placeholder ? card : twin)?.querySelector<HTMLElement>(".card-permalink");
    returnTo?.focus({ preventScroll: true });

    if (restoreURL) {
      history.pushState({}, "", "/");
      document.title = homeTitle;
    }
  }

  // A link outside any card zooms the card its page renders.
  async function openFrom(url: string): Promise<void> {
    try {
      const doc = await fetchDocument(url);
      const card = doc.querySelector<HTMLElement>("[data-solo] .card");
      if (!card) throw new Error(`No card at ${url}`);
      await open(document.adoptNode(card));
    } catch {
      window.location.assign(url);
    }
  }

  function requestClose(): void {
    if (!current) return;
    const state = zoomState();
    if (state.fromFeed && state.zoom === current.path) {
      history.back();
    } else {
      close();
    }
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const trigger = (event.target as Element | null)?.closest(".card-permalink, [data-zoom]");
    if (!trigger) return;
    const card = trigger.closest<HTMLElement>(".card");
    if (card) {
      if (card.classList.contains("is-open")) return;
      event.preventDefault();
      open(card);
    } else if (trigger instanceof HTMLAnchorElement) {
      event.preventDefault();
      openFrom(trigger.href);
    }
  });

  closeButton.addEventListener("click", requestClose);
  scrim.addEventListener("click", requestClose);
  zoom.addEventListener("click", (event) => {
    if (event.target === zoom) requestClose();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault();
    const field = event.target;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.value) {
      field.blur();
      return;
    }
    requestClose();
  });

  window.addEventListener("popstate", async () => {
    const path = pathFromLocation();
    if (path) {
      if (current?.path === path) return;
      const card = cardFor(path);
      if (card) {
        await open(card, { push: false });
        return;
      }
      window.location.reload();
    } else if (current) {
      await close({ restoreURL: false });
      document.title = homeTitle;
    }
  });

  // A deep link lands with its card already on the page: lift it straight into the zoom.
  const solo = document.querySelector<HTMLElement>("[data-solo] .card");
  if (solo) {
    history.replaceState({ zoom: solo.dataset.path, fromFeed: false } satisfies ZoomState, "");
    open(solo, { push: false });
  }

  return { open, close };
}
