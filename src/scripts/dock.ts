const SLACK = 8;

export function initDock(): void {
  const found = document.querySelector<HTMLElement>(".dock");
  if (!found) return;
  const dock = found;
  let anchor = window.scrollY;

  window.addEventListener(
    "scroll",
    () => {
      // Clamped so overscroll bounce at either end doesn't read as a reversal.
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const y = Math.max(0, Math.min(window.scrollY, max));
      if (y === 0) {
        dock.classList.remove("is-tucked");
        anchor = 0;
        return;
      }
      if (Math.abs(y - anchor) < SLACK) return;
      dock.classList.toggle("is-tucked", y > anchor);
      anchor = y;
    },
    { passive: true }
  );
}
