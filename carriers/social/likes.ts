import type { CarrierSqlStatement } from "@archival/carrier";
import { blueskyLikes, type Named } from "./atproto";
import { person, type Person } from "./fediverse";
import { actingUser } from "./auth";
import { now } from "./db";
import { type Context, type Env, fail, json, postPaths, text } from "./http";
import { mentionAuthor, mentions } from "./webmentions";

const SHOWN = 24;
const SYNCS_PER_RUN = 50;

export interface Reactions {
  count: number;
  people: Person[];
}

export const localLikesQuery = (path: string): [string, string] => [
  `select likes as n from like_counts where slug = ?`,
  path,
];

async function readFediverse(kind: "likes" | "boosts", context: Context, path: string): Promise<Named> {
  try {
    const page = await context.site.activitypub[kind](path, { limit: SHOWN });
    return { total: page.total, people: page.items.map((reaction) => person(reaction.account)) };
  } catch (error) {
    console.error(`fediverse ${kind}`, path, error);
    return { total: 0, people: [] };
  }
}

export const fediverseLikes = (context: Context, path: string) => readFediverse("likes", context, path);
export const fediverseBoosts = (context: Context, path: string) => readFediverse("boosts", context, path);

export const listed = (people: Person[]): Named => ({ total: people.length, people });

// Likes made here add to the count without names; fediverse and Bluesky accounts and other sites are named.
export const reactions = (local: number, ...named: Named[]): Reactions => ({
  count: local + named.reduce((sum, group) => sum + group.total, 0),
  people: named.flatMap((group) => group.people),
});

// One like per account. `like_counts` also holds likes from before accounts, so it moves by one rather than being recounted.
async function change(context: Context, on: boolean): Promise<Response> {
  const path = text(context.body?.path);
  if (!postPaths(context).has(path)) return fail("That post doesn't exist.", 404);
  const user = await actingUser(context, "Sign in to like posts.");
  if (user instanceof Response) return user;
  const mine = `select 1 from user_likes where slug = ? and user_id = ?`;
  const statements: CarrierSqlStatement[] = on
    ? [
        [`insert into like_counts (slug, likes) values (?, 0) on conflict (slug) do nothing`, path],
        [`update like_counts set likes = likes + 1 where slug = ? and not exists (${mine})`, path, path, user.id],
        [`insert or ignore into user_likes (slug, user_id, created_at) values (?, ?, ?)`, path, user.id, now()],
      ]
    : [
        [`update like_counts set likes = max(likes - 1, 0) where slug = ? and exists (${mine})`, path, path, user.id],
        [`delete from user_likes where slug = ? and user_id = ?`, path, user.id],
      ];
  const [results, fediverse, bluesky, elsewhere] = await Promise.all([
    context.db.transaction([...statements, [`select likes from like_counts where slug = ?`, path]]),
    fediverseLikes(context, path),
    blueskyLikes(context, path),
    mentions(context, path, "like"),
  ]);
  const [row] = results[results.length - 1];
  const likes = reactions(Number(row?.likes ?? 0), fediverse, bluesky, listed(elsewhere.map(mentionAuthor)));
  return json({ likes, liked: on });
}

export const like = (context: Context) => change(context, true);
export const unlike = (context: Context) => change(context, false);

// Tells the fediverse each post's local count, so other servers add it to their like counts.
export async function syncLikes(env: Env): Promise<number> {
  const known = postPaths(env);
  const stale = await env.db.all<{ slug: string; likes: number }>(
    `select slug, likes from like_counts where synced is null or synced != likes limit ?`,
    SYNCS_PER_RUN,
  );
  const synced: CarrierSqlStatement[] = [];
  for (const { slug, likes } of stale) {
    if (!known.has(slug)) continue;
    try {
      await env.site.activitypub.setLocalLikes(slug, likes);
      // Only if nobody liked it meanwhile; otherwise the next run sends the newer count.
      synced.push([`update like_counts set synced = ? where slug = ? and likes = ?`, likes, slug, likes]);
    } catch (error) {
      console.error("setLocalLikes", slug, error);
    }
  }
  await env.db.batch(synced);
  return synced.length;
}
