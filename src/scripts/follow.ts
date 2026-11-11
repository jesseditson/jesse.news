import { fediverseForm, read } from "./social.js";

interface Account {
  handle: string | null;
  followers: number;
  fediverseFollowers: number;
  emailSubscribers: number;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export async function initFollow(): Promise<void> {
  const note = document.querySelector<HTMLElement>("[data-follow]");
  const handle = note?.querySelector<HTMLButtonElement>("[data-follow-handle]");
  const followers = note?.querySelector<HTMLElement>("[data-follow-count]");
  const copied = note?.querySelector<HTMLElement>("[data-follow-copied]");
  if (!note || !handle || !followers || !copied) return;

  let account: Account;
  try {
    account = await read<Account>("account");
  } catch {
    return;
  }
  if (!account.handle) return;

  handle.textContent = account.handle;
  followers.textContent = plural(account.followers, "follower");
  followers.title = `${plural(account.fediverseFollowers, "follower")} on the fediverse, ${plural(account.emailSubscribers, "subscriber")} by email`;
  note.after(
    fediverseForm({
      path: null,
      summary: "Follow from Mastodon or another fediverse server",
      explain: "Enter your handle and your server will open this site's account, where you can follow it. New posts then arrive in your home feed.",
      searchFor: account.handle,
    }),
  );
  note.hidden = false;

  handle.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(account.handle ?? "");
      copied.textContent = "Copied";
      setTimeout(() => (copied.textContent = ""), 1600);
    } catch {
      // No clipboard access: the handle is still on screen to copy by hand.
    }
  });
}
