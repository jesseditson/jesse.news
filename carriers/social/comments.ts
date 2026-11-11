import type { CarrierReply, CarrierReplyAttachment, CarrierWebmention } from "@archival/carrier";
import { fediverseBoosts, fediverseLikes, localLikesQuery, reactions } from "./likes";
import { now } from "./db";
import { person, type Person, replies } from "./fediverse";
import { actingUser } from "./auth";
import { type Context, fail, json, postPaths, text } from "./http";
import { isListed, mentionAuthor, mentionCounts, mentions, toMention } from "./webmentions";

const MAX_BODY = 2000;
const MAX_COUNTED = 100;
const HOUR_MS = 60 * 60 * 1000;
const COMMENTS_PER_HOUR = 10;
const SITE_COMMENTS_PER_HOUR = 30;

type CommentRow = {
  id: number;
  slug: string;
  parent_id: number | null;
  author: string;
  body: string;
  role: string;
  created_at: string;
  user_id: number | null;
};

interface Comment {
  // A site comment's row id, a fediverse reply's ActivityPub id, or the page a webmention came from.
  id: string;
  source: "site" | "fediverse" | "webmention";
  parentId: string | null;
  author: Person;
  // The account that wrote a site comment; null for fediverse replies and comments from before accounts.
  authorId: number | null;
  role: string;
  createdAt: string;
  body?: string;
  html?: string;
  summary?: string | null;
  sensitive?: boolean;
  attachments?: CarrierReplyAttachment[];
  url?: string | null;
  replies?: Comment[];
}

const fromRow = (row: CommentRow): Comment => ({
  id: String(row.id),
  source: "site",
  parentId: row.parent_id === null ? null : String(row.parent_id),
  author: { name: row.author, handle: null, url: null, icon: null },
  authorId: row.user_id === null ? null : Number(row.user_id),
  role: row.role,
  createdAt: row.created_at,
  body: row.body,
});

const fromReply = (reply: CarrierReply): Comment => ({
  id: reply.id,
  source: "fediverse",
  parentId: reply.inReplyTo,
  author: person(reply.account),
  authorId: null,
  role: "reader",
  createdAt: reply.published,
  html: reply.content,
  summary: reply.summary,
  sensitive: reply.sensitive,
  attachments: reply.attachments,
  url: reply.url,
});

const fromMention = (mention: CarrierWebmention): Comment => ({
  id: mention.source,
  source: "webmention",
  parentId: null,
  author: mentionAuthor(mention),
  authorId: null,
  role: "reader",
  createdAt: mention.published ?? mention.received,
  html: mention.content ?? "",
  url: mention.url,
});

// Threads are two levels deep: a reply to a reply hangs off the comment that started it.
function nest(comments: Comment[]): Comment[] {
  const top: Comment[] = [];
  const rootOf = new Map<string, Comment>();
  for (const comment of comments) {
    const root = comment.parentId === null ? undefined : rootOf.get(comment.parentId);
    if (root) {
      root.replies?.push({ ...comment, parentId: root.id });
      rootOf.set(comment.id, root);
    } else {
      const entry = { ...comment, parentId: null, replies: [] };
      top.push(entry);
      rootOf.set(entry.id, entry);
    }
  }
  return top;
}

const byDate = (a: Comment, b: Comment) => a.createdAt.localeCompare(b.createdAt);

export async function thread(context: Context): Promise<Response> {
  const path = context.params.get("path") ?? "";
  if (!postPaths(context).has(path)) return fail("unknown thread", 404);

  const [[rows, [local]], fediverse, likes, boosts, elsewhere] = await Promise.all([
    context.db.transaction([
      // An account's current name and role, so a rename or a claimed author role reaches past comments.
      [
        `select c.id, c.slug, c.parent_id, coalesce(u.name, c.author) as author, c.body, coalesce(u.role, c.role) as role,
                c.created_at, c.user_id
           from comments c left join users u on u.id = c.user_id
          where c.slug = ? order by c.created_at, c.id`,
        path,
      ],
      localLikesQuery(path),
    ]),
    replies(context, path),
    fediverseLikes(context, path),
    fediverseBoosts(context, path),
    mentions(context, path),
  ]);
  const site = nest((rows as CommentRow[]).map(fromRow));
  const remote = nest(fediverse.map(fromReply));
  // A site that federates and sends webmentions delivers the same reply both ways.
  const federated = new Set(fediverse.flatMap((reply) => [reply.id, reply.url]));
  const linked = elsewhere
    .filter((mention) => mention.kind === "reply" && !federated.has(mention.url) && !federated.has(mention.source))
    .map(fromMention);
  const people = (kind: CarrierWebmention["kind"]) =>
    elsewhere.filter((mention) => mention.kind === kind).map(mentionAuthor);
  return json({
    comments: [...site, ...remote, ...linked].sort(byDate),
    count: rows.length + fediverse.length + linked.length,
    likes: reactions(likes, Number(local?.n ?? 0), people("like")),
    boosts: reactions(boosts, 0, people("repost")),
    mentions: elsewhere.filter(isListed).map(toMention),
  });
}

export async function counts(context: Context): Promise<Response> {
  const known = postPaths(context);
  const paths = [...new Set((context.params.get("paths") ?? "").split(","))]
    .filter((path) => known.has(path))
    .slice(0, MAX_COUNTED);
  const result: Record<string, { comments: number; likes: number; boosts: number }> = {};
  if (!paths.length) return json({ counts: result });

  const marks = paths.map(() => "?").join(",");
  const [[comments, likes], fediverse, elsewhere] = await Promise.all([
    context.db.transaction([
      [`select slug, count(*) as n from comments where slug in (${marks}) group by slug`, ...paths],
      [`select slug, likes as n from like_counts where slug in (${marks})`, ...paths],
    ]),
    context.site.activitypub.counts(paths).catch((error) => {
      console.error("fediverse counts", error);
      return paths.map(() => ({ likes: 0, boosts: 0, replies: 0 }));
    }),
    mentionCounts(context, paths),
  ]);
  paths.forEach(
    (path, i) =>
      (result[path] = {
        comments: fediverse[i].replies + elsewhere[i].replies,
        likes: fediverse[i].likes + elsewhere[i].likes,
        boosts: fediverse[i].boosts + elsewhere[i].reposts,
      }),
  );
  for (const row of comments) result[String(row.slug)].comments += Number(row.n);
  for (const row of likes) result[String(row.slug)].likes += Number(row.n);
  return json({ counts: result }, 200, "public, max-age=60");
}

export async function create(context: Context): Promise<Response> {
  const body = context.body ?? {};
  const path = text(body.path);
  const content = text(body.body).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  const parentId = typeof body.parentId === "number" || typeof body.parentId === "string" ? Number(body.parentId) : null;

  if (!postPaths(context).has(path)) return fail("That post doesn't exist.", 404);
  if (!content || content.length > MAX_BODY) return fail("Comments run 1 to 2000 characters.");
  if (parentId !== null && !Number.isInteger(parentId)) return fail("Replies on the fediverse are answered there.");
  const user = await actingUser(context, "Sign in to comment.");
  if (user instanceof Response) return user;

  const [recent] = await context.db.all<{ mine: number; all: number }>(
    `select coalesce(sum(user_id = ?), 0) as mine, count(*) as "all" from comments where created_at > ?`,
    user.id,
    new Date(Date.now() - HOUR_MS).toISOString(),
  );
  if (Number(recent?.mine) >= COMMENTS_PER_HOUR) return fail("That's a lot of comments. Try again in a bit.", 429);
  if (Number(recent?.all) >= SITE_COMMENTS_PER_HOUR) return fail("Lots of comments right now. Try again in a bit.", 429);

  let parent: number | null = null;
  if (parentId !== null) {
    const row = await context.db.one<{ id: number; parent_id: number | null }>(
      `select id, parent_id from comments where id = ? and slug = ?`,
      parentId,
      path,
    );
    if (!row) return fail("That comment is gone.", 404);
    parent = row.parent_id === null ? Number(row.id) : Number(row.parent_id);
  }

  const [row] = await context.db.all<CommentRow>(
    `insert into comments (slug, parent_id, author, body, role, created_at, user_id) values (?, ?, ?, ?, ?, ?, ?) returning *`,
    path,
    parent,
    user.name,
    content,
    user.role,
    now(),
    user.id,
  );
  return json({ comment: row ? fromRow(row) : null }, 201);
}

// Anyone can remove their own comment; the author can remove any, with its replies.
export async function remove(context: Context): Promise<Response> {
  const user = await actingUser(context);
  if (user instanceof Response) return user;
  const id = Number(context.body?.id);
  if (!Number.isInteger(id)) return fail("Which comment?");
  const comment = await context.db.one<{ user_id: number | null }>(`select user_id from comments where id = ?`, id);
  if (!comment) return fail("That comment is gone.", 404);
  const moderator = user.role === "author";
  if (!moderator && Number(comment.user_id) !== user.id) return fail("That isn't your comment.", 403);
  const removed = moderator
    ? await context.db.all(`delete from comments where id = ? or parent_id = ? returning id`, id, id)
    : await context.db.all(`delete from comments where id = ? returning id`, id);
  return json({ ok: removed.length > 0, removed: removed.length });
}
