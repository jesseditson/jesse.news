import { account, asUser, requireAccount } from "./account.js";
import {
  avatar,
  cleanHTML,
  el,
  fediverseForm,
  hostOf,
  hue,
  initials,
  type Person,
  read,
} from "./social.js";

const BOOST_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17 2.5 20.5 6 17 9.5M3.5 11.5v-1A4.5 4.5 0 0 1 8 6h12.5M7 21.5 3.5 18 7 14.5M20.5 12.5v1A4.5 4.5 0 0 1 16 18H3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const HEART_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20.25s-7.75-4.6-7.75-10.5A4.25 4.25 0 0 1 12 7.3a4.25 4.25 0 0 1 7.75 2.45c0 5.9-7.75 10.5-7.75 10.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

interface Attachment {
  url: string;
  mediaType: string | null;
  description: string | null;
}

interface Comment {
  id: string;
  source: "site" | "fediverse" | "webmention";
  parentId: string | null;
  author: Person;
  authorId: number | null;
  role: string;
  createdAt: string;
  body?: string;
  html?: string;
  summary?: string | null;
  sensitive?: boolean;
  attachments?: Attachment[];
  url?: string | null;
  replies?: Comment[];
}

interface Mention {
  url: string;
  title: string | null;
  kind: "mention" | "bookmark";
  author: Person;
  createdAt: string;
}

interface Reactions {
  count: number;
  people: Person[];
}

interface Counts {
  comments: number;
  likes: number;
  boosts: number;
}

const shortDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

let sections = 0;

function buildSection(): HTMLElement {
  const n = ++sections;
  const section = el("section", "comments");
  section.setAttribute("aria-label", "Likes, boosts and comments");
  section.innerHTML = `
    <div class="reactions">
      <div class="reaction-row">
        <button type="button" class="like-button" data-like aria-pressed="false">
          ${HEART_ICON}
          <span data-like-label>Like</span>
          <span class="like-count" data-like-count></span>
        </button>
        <p class="reaction-people" data-liked-by></p>
      </div>
      <p class="reaction-people reaction-people--boosts" data-boosted-by></p>
      <p class="comment-error" data-like-error role="alert"></p>
    </div>
    <div class="mentions" data-mentions hidden>
      <h2 class="comments-title">Mentioned on</h2>
      <ul class="mentions-list" data-mentions-list></ul>
    </div>
    <h2 class="comments-title">Comments<span class="comments-count" data-comments-total></span></h2>
    <p class="comments-status" data-comments-status role="status" aria-live="polite">Loading comments…</p>
    <ol class="comments-list" data-comments-list></ol>
    <form class="comment-form" data-comment-form novalidate>
      <div class="comment-form-identity">
        <span class="comment-avatar comment-avatar--you is-empty" data-comment-you aria-hidden="true">?</span>
        <span class="comment-you-name" data-comment-you-name></span>
        <button type="button" class="comment-signin" data-comment-signin>Sign in to comment</button>
      </div>
      <p class="comment-replying" data-comment-reply-to hidden>
        Replying to <span data-comment-reply-name></span>
        <button type="button" class="comment-reply-cancel" data-comment-reply-cancel>Cancel</button>
      </p>
      <div class="comment-form-send">
        <label class="visually-hidden" for="comment-body-${n}">Leave a comment</label>
        <textarea class="comment-input" id="comment-body-${n}" data-comment-body rows="1" maxlength="2000" placeholder="Leave a comment" required></textarea>
        <button class="comment-post" type="submit" data-comment-post>Post</button>
      </div>
      <p class="comment-error" data-comment-error role="alert"></p>
    </form>`;
  return section;
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function authorName(who: Person, url: string | null): HTMLElement {
  if (!url) return el("span", "comment-author", who.name);
  const link = el("a", "comment-author", who.name);
  link.href = url;
  link.rel = "nofollow noopener ugc";
  link.target = "_blank";
  return link;
}

function remoteBody(comment: Comment): HTMLElement {
  const bubble = el("div", "comment-bubble comment-bubble--html");
  bubble.append(cleanHTML(comment.html ?? ""));
  for (const attachment of comment.attachments ?? []) {
    if (!attachment.url.startsWith("https://")) continue;
    const link = el("a", "comment-attachment");
    link.href = attachment.url;
    link.rel = "nofollow noopener ugc";
    link.target = "_blank";
    if (attachment.mediaType?.startsWith("image/")) {
      const image = el("img");
      image.src = attachment.url;
      image.alt = attachment.description ?? "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      link.append(image);
    } else {
      link.textContent = attachment.description || `Attachment on ${hostOf(attachment.url)}`;
    }
    bubble.append(link);
  }
  if (!comment.summary && !comment.sensitive) return bubble;
  const warning = el("details", "comment-warning");
  warning.append(el("summary", "", comment.summary || "Sensitive content"), bubble);
  return warning;
}

// "Liked by Alice, Bob and 3 others", where the others include anyone who liked here without an account.
function renderPeople(target: HTMLElement, verb: string, reactions: Reactions, icon = ""): void {
  target.replaceChildren();
  const named = reactions.people.slice(0, 2).map((person) => person.name);
  if (!named.length) return;
  const others = reactions.count - named.length;
  const faces = el("span", "reaction-faces");
  for (const person of reactions.people.slice(0, 6)) faces.append(avatar(person, "reaction-face"));
  const words = el("span", "reaction-names");
  words.textContent = `${verb} by ${named.join(named.length === 2 && others <= 0 ? " and " : ", ")}${others > 0 ? ` and ${plural(others, "other")}` : ""}`;
  words.title = reactions.people.map((person) => (person.handle ? `${person.name} (${person.handle})` : person.name)).join("\n");
  if (icon) target.insertAdjacentHTML("afterbegin", icon);
  target.append(faces, words);
}

function renderMention(mention: Mention): HTMLLIElement {
  const item = el("li", "mention");
  const link = el("a", "mention-link", mention.title || hostOf(mention.url));
  if (mention.url.startsWith("https://")) {
    link.href = mention.url;
    link.rel = "nofollow noopener ugc";
    link.target = "_blank";
  }
  const about = [mention.kind === "bookmark" ? "Bookmarked" : "", mention.author.name, hostOf(mention.url)];
  const meta = el("span", "mention-meta", [...new Set(about.filter(Boolean))].join(" · "));
  const time = el("time", "", shortDate(mention.createdAt));
  time.dateTime = mention.createdAt;
  if (time.textContent) meta.append(" · ", time);
  const text = el("span", "mention-text");
  text.append(link, meta);
  item.append(avatar(mention.author, "mention-avatar"), text);
  return item;
}

function mountThread(card: HTMLElement, path: string): void {
  const body = card.querySelector(".card-body");
  if (!body || card.querySelector(".comments")) return;
  const root = buildSection();
  body.append(root);

  const list = query<HTMLOListElement>(root, "[data-comments-list]");
  const status = query<HTMLElement>(root, "[data-comments-status]");
  const total = query<HTMLElement>(root, "[data-comments-total]");
  const form = query<HTMLFormElement>(root, "[data-comment-form]");
  const youName = query<HTMLElement>(form, "[data-comment-you-name]");
  const signIn = query<HTMLButtonElement>(form, "[data-comment-signin]");
  const bodyField = query<HTMLTextAreaElement>(form, "[data-comment-body]");
  const post = query<HTMLButtonElement>(form, "[data-comment-post]");
  const error = query<HTMLElement>(form, "[data-comment-error]");
  const replyTo = query<HTMLElement>(form, "[data-comment-reply-to]");
  const replyToName = query<HTMLElement>(form, "[data-comment-reply-name]");
  const cancelReply = query<HTMLButtonElement>(form, "[data-comment-reply-cancel]");
  const youAvatar = query<HTMLElement>(form, "[data-comment-you]");

  const likeButton = query<HTMLButtonElement>(root, "[data-like]");
  const likeLabel = query<HTMLElement>(root, "[data-like-label]");
  const likeCount = query<HTMLElement>(root, "[data-like-count]");
  const likedBy = query<HTMLElement>(root, "[data-liked-by]");
  const boostedBy = query<HTMLElement>(root, "[data-boosted-by]");
  const likeError = query<HTMLElement>(root, "[data-like-error]");
  const mentionsBlock = query<HTMLElement>(root, "[data-mentions]");
  const mentionsList = query<HTMLUListElement>(root, "[data-mentions-list]");

  root.append(
    fediverseForm({
      path,
      summary: "On Mastodon? Reply, like or boost from your own account",
      explain:
        "Enter your handle and your server will open this post, where you can reply to it, like it or boost it. What you do there shows up here.",
      searchFor: new URL(`/${path}.html`, window.location.origin).href,
    }),
  );

  let count = 0;
  let parentId: string | null = null;
  let likes: Reactions = { count: 0, people: [] };
  let boosts: Reactions = { count: 0, people: [] };
  const badge = () => updateBadge(card, { comments: count, likes: likes.count, boosts: boosts.count });

  const setCount = (next: number) => {
    count = next;
    total.textContent = count ? ` · ${count}` : "";
    badge();
  };
  const setLikes = (next: Reactions, on = account.likes(path)) => {
    likes = next;
    likeButton.setAttribute("aria-pressed", String(on));
    likeLabel.textContent = on ? "Liked" : "Like";
    likeCount.textContent = next.count ? String(next.count) : "";
    likeButton.setAttribute("aria-label", `${on ? "Liked" : "Like"}${next.count ? `, ${plural(next.count, "like")}` : ""}`);
    renderPeople(likedBy, "Liked", next);
  };
  const setBoosts = (next: Reactions) => {
    boosts = next;
    renderPeople(boostedBy, "Boosted", next, BOOST_ICON);
  };
  const setYou = () => {
    const name = account.user?.name ?? "";
    youAvatar.classList.toggle("is-empty", !name);
    youAvatar.style.setProperty("--comment-hue", String(hue(name)));
    youAvatar.textContent = name ? initials(name) : "?";
    youName.textContent = name;
    signIn.hidden = !!name;
  };
  const growBody = () => {
    bodyField.style.height = "auto";
    bodyField.style.height = `${bodyField.scrollHeight}px`;
  };

  setYou();
  setLikes(likes);
  bodyField.addEventListener("input", growBody);
  signIn.addEventListener("click", () => requireAccount("comment", signIn.parentElement).catch(() => undefined));
  // Signing in or out changes what this visitor has liked and which comments they can remove.
  account.onChange(() => {
    setYou();
    load();
  });

  likeButton.addEventListener("click", async () => {
    likeError.textContent = "";
    try {
      await requireAccount("like this post", likeButton.closest(".reaction-row"));
    } catch {
      return;
    }
    const on = !account.likes(path);
    likeButton.disabled = true;
    try {
      const result = await asUser<{ likes: Reactions }>(on ? "like" : "unlike", { path });
      account.setLiked(path, on);
      setLikes(result.likes, on);
      badge();
    } catch (thrown) {
      likeError.textContent = thrown instanceof Error ? thrown.message : "That didn't go through. Please try again.";
    } finally {
      likeButton.disabled = false;
    }
  });

  async function removeComment(comment: Comment): Promise<void> {
    try {
      await asUser("remove", { id: comment.id });
    } catch {
      return;
    }
    await load();
  }

  const canRemove = (comment: Comment) =>
    !!account.user && (account.user.role === "author" || comment.authorId === account.user.id);

  function renderComment(comment: Comment, depth = 0): HTMLLIElement {
    const item = el("li", "comment");
    item.dataset.commentId = comment.id;
    if (comment.role === "author") item.classList.add("is-author");
    const remote = comment.source !== "site";
    if (remote) item.classList.add(`is-${comment.source}`);

    const head = el("div", "comment-head");
    head.append(avatar(comment.author), authorName(comment.author, remote ? comment.author.url : null));
    if (comment.role === "author") head.append(el("span", "comment-badge", "Author"));
    const handle = comment.source === "webmention" ? hostOf(comment.url ?? null) : comment.author.handle;
    if (remote && handle && handle !== comment.author.name) head.append(el("span", "comment-handle", handle));
    const time = el("time", "comment-date", shortDate(comment.createdAt));
    time.dateTime = comment.createdAt;
    time.title = new Date(comment.createdAt).toLocaleString();
    head.append(time);
    item.append(head, remote ? remoteBody(comment) : el("div", "comment-bubble", comment.body ?? ""));

    const actions = el("div", "comment-actions");
    if (remote) {
      if (comment.url?.startsWith("https://")) {
        const view = el("a", "comment-action", `Reply on ${hostOf(comment.url)}`);
        view.href = comment.url;
        view.rel = "nofollow noopener ugc";
        view.target = "_blank";
        actions.append(view);
      }
    } else {
      if (depth === 0) {
        const reply = el("button", "comment-action", "Reply");
        reply.type = "button";
        reply.addEventListener("click", () => startReply(comment, item));
        actions.append(reply);
      }
      if (canRemove(comment)) {
        const remove = el("button", "comment-action", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => removeComment(comment));
        actions.append(remove);
      }
    }
    if (actions.childElementCount) item.append(actions);

    if (depth === 0) {
      const replies = el("ol", "comment-replies");
      replies.dataset.commentReplies = "";
      comment.replies?.forEach((child) => replies.append(renderComment(child, depth + 1)));
      item.append(replies);
    }
    return item;
  }

  function startReply(comment: Comment, item: HTMLElement): void {
    parentId = comment.id;
    replyToName.textContent = comment.author.name;
    replyTo.hidden = false;
    (item.querySelector("[data-comment-replies]") ?? item).after(form);
    form.classList.add("is-replying");
    bodyField.focus();
  }

  function endReply(): void {
    parentId = null;
    replyTo.hidden = true;
    form.classList.remove("is-replying");
    list.after(form);
  }
  cancelReply.addEventListener("click", endReply);

  function insert(comment: Comment): void {
    const parent =
      comment.parentId === null
        ? null
        : list.querySelector(`[data-comment-id="${CSS.escape(comment.parentId)}"] [data-comment-replies]`);
    if (parent) parent.append(renderComment(comment, 1));
    else list.append(renderComment(comment));
  }

  async function load(): Promise<void> {
    try {
      const thread = await read<{
        comments: Comment[];
        count: number;
        likes: Reactions;
        boosts: Reactions;
        mentions: Mention[];
      }>("thread", { path });
      list.replaceChildren(...thread.comments.map((comment) => renderComment(comment)));
      mentionsList.replaceChildren(...thread.mentions.map(renderMention));
      mentionsBlock.hidden = !thread.mentions.length;
      setLikes(thread.likes);
      setBoosts(thread.boosts);
      setCount(thread.count);
      status.textContent = thread.count ? "" : "No comments yet. Go first.";
    } catch {
      status.textContent = "Couldn't load the comments. Reopen this card to try again.";
    }
  }

  async function send(): Promise<void> {
    const { comment } = await asUser<{ comment: Comment }>("comment", { path, body: bodyField.value, parentId });
    endReply();
    insert(comment);
    setCount(count + 1);
    status.textContent = "";
    bodyField.value = "";
    growBody();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    if (!bodyField.value.trim()) {
      error.textContent = "Write a comment first.";
      return;
    }
    try {
      await requireAccount("post your comment", form.querySelector(".comment-form-send"));
    } catch {
      return;
    }
    post.disabled = true;
    try {
      await send();
    } catch (thrown) {
      error.textContent = thrown instanceof Error ? thrown.message : "That didn't post. Please try again.";
    } finally {
      post.disabled = false;
    }
  });

  bodyField.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  load();
}

function updateBadge(card: Element, counts: Counts): void {
  const head = card.querySelector(".card-head");
  if (!head) return;
  let badge = head.querySelector<HTMLElement>(".card-comments");
  const parts = [
    counts.likes ? plural(counts.likes, "like") : "",
    counts.boosts ? plural(counts.boosts, "boost") : "",
    counts.comments ? plural(counts.comments, "comment") : "",
  ].filter(Boolean);
  if (!parts.length) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = el("span", "card-comments");
    head.querySelector(".card-permalink")?.before(badge);
  }
  badge.textContent = parts.join(" · ");
}

export function initComments(): void {
  const counted = new Set<string>();

  async function countCards(cards: Iterable<Element>): Promise<void> {
    const paths = new Set<string>();
    for (const card of cards) {
      const path = (card as HTMLElement).dataset.path;
      if (path && path !== "contact" && !counted.has(path)) paths.add(path);
    }
    const pending = [...paths];
    for (let i = 0; i < pending.length; i += 50) {
      const chunk = pending.slice(i, i + 50);
      chunk.forEach((path) => counted.add(path));
      try {
        const { counts } = await read<{ counts: Record<string, Counts> }>("counts", { paths: chunk.join(",") });
        for (const [path, value] of Object.entries(counts)) {
          document
            .querySelectorAll(`.card[data-path="${CSS.escape(path)}"]`)
            .forEach((card) => updateBadge(card, value));
        }
      } catch {
        // Counts are a nicety; cards work without them.
      }
    }
  }

  countCards(document.querySelectorAll(".card[data-path]"));
  document.addEventListener("feed:cards", (event) => countCards(event.detail.cards));
  document.addEventListener("card:open", (event) => {
    const { card } = event.detail;
    const path = card.dataset.path;
    if (path && path !== "contact") mountThread(card, path);
  });
}
