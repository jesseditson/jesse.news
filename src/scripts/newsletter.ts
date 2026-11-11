import { read, write } from "./social.js";

const KEY = "jesse.news:newsletter";
const SETTLE_MS = 3500;

interface Subscription {
  address: string;
  status: "pending" | "confirmed";
  token?: string;
}

interface SubscribeResponse {
  status?: "pending" | "confirmed";
  address?: string;
  token?: string;
}

const storage = {
  read(): Subscription | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "null") as Subscription | null;
      return parsed && typeof parsed.address === "string" ? parsed : null;
    } catch {
      return null;
    }
  },
  write(subscription: Subscription | null): void {
    try {
      if (subscription) localStorage.setItem(KEY, JSON.stringify(subscription));
      else localStorage.removeItem(KEY);
    } catch {
      // Private mode: the note just won't survive a reload.
    }
  },
};

export function initNewsletter(): void {
  const form = document.querySelector<HTMLFormElement>("[data-newsletter-form]");
  const foundNote = document.querySelector<HTMLElement>("[data-newsletter-note]");
  const foundText = foundNote?.querySelector<HTMLElement>("[data-newsletter-note-text]");
  const foundButton = foundNote?.querySelector<HTMLButtonElement>("[data-newsletter-unsubscribe]");
  if (!foundNote || !foundText || !foundButton) return;
  const note = foundNote;
  const noteText = foundText;
  const unsubscribe = foundButton;

  let subscription = storage.read();
  let dismissed = false;

  function render(): void {
    if (form) form.hidden = !!subscription || dismissed;
    note.hidden = !subscription;
    if (!subscription) return;
    noteText.textContent =
      subscription.status === "confirmed"
        ? `Sending updates to ${subscription.address}.`
        : `Confirm the link we sent to ${subscription.address} to start updates.`;
    unsubscribe.textContent = subscription.status === "confirmed" ? "Unsubscribe" : "Cancel";
  }

  function save(next: Subscription | null): void {
    subscription = next;
    storage.write(next);
    render();
  }

  function followHash(): void {
    if (window.location.hash === "#newsletter-removed") save(null);
    if (window.location.hash === "#newsletter-confirmed" && subscription) save({ ...subscription, status: "confirmed" });
  }

  async function refreshStatus(): Promise<void> {
    if (!subscription?.token || subscription.status !== "pending") return;
    try {
      const { status } = await read<{ status?: string }>("status", { token: subscription.token });
      if (status === "confirmed") save({ ...subscription, status: "confirmed" });
      else if (status === "removed" || status === "unknown") save(null);
    } catch {
      // Leave the note as it is; the next visit will check again.
    }
  }

  unsubscribe.addEventListener("click", async () => {
    if (!subscription) return;
    if (!subscription.token) {
      noteText.textContent = "Use the unsubscribe link at the bottom of any update to stop them.";
      return;
    }
    unsubscribe.disabled = true;
    try {
      await write("unsubscribe", { token: subscription.token });
      save(null);
    } catch {
      noteText.textContent = "That didn't go through. Try again in a bit.";
    } finally {
      unsubscribe.disabled = false;
    }
  });

  if (form) {
    form.querySelector<HTMLButtonElement>("[data-newsletter-dismiss]")?.addEventListener("click", () => {
      dismissed = true;
      render();
    });

    const input = form.querySelector<HTMLInputElement>('input[name="address"]');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = form.querySelector<HTMLElement>("[data-newsletter-status]");
    if (input && button && status) {
      const say = (text: string) => (status.textContent = text);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const address = input.value.trim();
        if (!address) {
          say("An email address, please.");
          return;
        }
        button.disabled = true;
        say("One moment…");
        try {
          const result = await write<SubscribeResponse>("subscribe", { address });
          if (!result.address || !result.status) throw new Error("That didn't go through. Try again in a bit.");
          say(result.status === "confirmed" ? "You're already subscribed." : "Check your email to confirm.");
          const next: Subscription = {
            address: result.address,
            status: result.status,
            ...(result.token ? { token: result.token } : {}),
          };
          input.value = "";
          setTimeout(() => {
            say("");
            save(next);
          }, SETTLE_MS);
        } catch (error) {
          say(error instanceof Error ? error.message : "That didn't go through. Try again in a bit.");
        } finally {
          button.disabled = false;
        }
      });
    }
  }

  followHash();
  window.addEventListener("hashchange", followHash);
  render();
  refreshStatus();
}
