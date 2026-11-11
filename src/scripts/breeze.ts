import { isMinimal } from "./mode.js";

type Range = readonly [number, number];

const FIRST_GUST: Range = [5000, 11000];
const BETWEEN_GUSTS: Range = [16000, 42000];
const WIND_SPEED = 0.85; // px per ms along the gust front

const between = ([min, max]: Range) => min + Math.random() * (max - min);

// Damped flutter: [offset, lift] where lift is a fraction of the gust's peak.
const FLUTTER: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.14, 1],
  [0.3, -0.38],
  [0.46, 0.52],
  [0.62, -0.2],
  [0.78, 0.14],
  [0.9, -0.04],
  [1, 0],
];

function keyframes(strength: number, twist: number): Keyframe[] {
  return FLUTTER.map(([offset, lift]) => {
    const x = (9 * lift * strength).toFixed(2);
    const y = (3.6 * lift * strength * twist).toFixed(2);
    const skew = (-1.4 * lift * strength * twist).toFixed(2);
    return {
      offset,
      transform: `perspective(40rem) rotateX(${x}deg) rotateY(${y}deg) skewX(${skew}deg)`,
    };
  });
}

function sheen(strength: number): Keyframe[] {
  return FLUTTER.map(([offset, lift]) => ({
    offset,
    opacity: Math.max(0, lift) * 0.9 * strength,
  }));
}

export function initBreeze({ prefersReducedMotion }: { prefersReducedMotion: boolean }): void {
  if (prefersReducedMotion) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(range: Range): void {
    clearTimeout(timer);
    timer = setTimeout(gust, between(range));
  }

  function gust(): void {
    schedule(BETWEEN_GUSTS);
    if (document.hidden || isMinimal()) return;

    const height = window.innerHeight;
    const strength = 0.45 + Math.random() * 0.55;
    const cards = document.querySelectorAll("[data-feed] .card:not(.is-open)");

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > height || !rect.width) continue;
      const paper = card.querySelector(".card-paper");
      if (!paper || paper.getAnimations().length) continue;

      // Distance along a front travelling from the bottom-left corner toward the top-right.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const along = (cx + (height - cy)) * Math.SQRT1_2;
      const delay = along / WIND_SPEED + Math.random() * 120;
      const local = strength * (0.7 + Math.random() * 0.5);
      const twist = 0.7 + Math.random() * 0.6;
      const duration = 1500 + Math.random() * 600;

      paper.animate(keyframes(local, twist), { duration, delay, easing: "ease-in-out" });
      paper.animate(sheen(local), { duration, delay, easing: "ease-in-out", pseudoElement: "::after" });
    }
  }

  schedule(FIRST_GUST);
}
