const KEY = "jesse.news:mode";
const root = document.documentElement;

export type Mode = "scenic" | "minimal";

declare global {
  interface DocumentEventMap {
    modechange: CustomEvent<{ mode: Mode }>;
  }
}

export const isMinimal = (): boolean => root.dataset.mode === "minimal";

export function whenScenic(): Promise<void> {
  if (!isMinimal()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (isMinimal()) return;
      document.removeEventListener("modechange", check);
      resolve();
    };
    document.addEventListener("modechange", check);
  });
}

export function initMode(): void {
  const radios = document.querySelectorAll<HTMLInputElement>('[data-mode-switch] input[name="mode"]');
  const sync = () => {
    const mode: Mode = isMinimal() ? "minimal" : "scenic";
    radios.forEach((radio) => (radio.checked = radio.value === mode));
  };

  radios.forEach((radio) =>
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const mode: Mode = radio.value === "minimal" ? "minimal" : "scenic";
      if (mode === "minimal") root.dataset.mode = "minimal";
      else delete root.dataset.mode;
      try {
        localStorage.setItem(KEY, mode);
      } catch {
        // Private mode: the choice lasts for this page only.
      }
      document.dispatchEvent(new CustomEvent("modechange", { detail: { mode } }));
    })
  );

  sync();
}
