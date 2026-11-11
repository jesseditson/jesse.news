export function startMedia(card: Element): void {
  const video = card.querySelector<HTMLVideoElement>(".photo--video video");
  if (video) {
    video.controls = true;
    video.loop = false;
    video.muted = false;
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  }
  card.querySelectorAll<HTMLAudioElement>(".tape audio").forEach((audio) => (audio.preload = "metadata"));
}

export function stopMedia(card: Element): void {
  card.querySelectorAll<HTMLMediaElement>("video, audio").forEach((el) => {
    el.pause();
    if (el instanceof HTMLVideoElement) {
      el.controls = false;
      el.muted = true;
      el.loop = true;
    }
  });
}

export function initMedia({ prefersReducedMotion }: { prefersReducedMotion: boolean }): void {
  const hovering = (event: Event) => (event.target as Element | null)?.closest?.(".card:not(.is-open)");
  const previewOf = (card: Element) => card.querySelector<HTMLVideoElement>(".photo--video video");

  document.addEventListener("pointerover", (event) => {
    if (prefersReducedMotion || event.pointerType === "touch") return;
    const card = hovering(event);
    if (!card || card.contains(event.relatedTarget as Node | null)) return;
    previewOf(card)?.play().catch(() => {});
  });

  document.addEventListener("pointerout", (event) => {
    const card = hovering(event);
    if (!card || card.contains(event.relatedTarget as Node | null)) return;
    previewOf(card)?.pause();
  });

  const setPlaying = (event: Event, playing: boolean) => {
    const host = (event.target as Element | null)?.closest?.(".photo--video, .tape");
    host?.classList.toggle("is-playing", playing);
  };
  document.addEventListener("play", (event) => setPlaying(event, true), true);
  document.addEventListener("pause", (event) => setPlaying(event, false), true);
  document.addEventListener("ended", (event) => setPlaying(event, false), true);
}
