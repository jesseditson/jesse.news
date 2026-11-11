import type { CarrierPage, CarrierReaction, CarrierSqlStatement } from "@archival/carrier";
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

type Fediverse = Pick<CarrierPage<CarrierReaction>, "total" | "items">;

export const localLikesQuery = (path: string): [string, string] => [
  `select likes as n from like_counts where slug = ?`,
  path,
];

async function readFediverse(read: () => Promise<Fediverse>, what: string, path: string): Promise<Fediverse> {
  try {
    return await read();
  } catch (error) {
    console.error(`fediverse ${what}`, path, error);
    return { total: 0, items: [] };
  }
}

export const fediverseLikes = (context: Context, path: string) =>
  readFediverse(() => context.site.activitypub.likes(path, { limit: SHOWN }), "likes", path);

export const fediverseBoosts = (context: Context, path: string) =>
  readFediverse(() => context.site.activitypub.boosts(path, { limit: SHOWN }), "boosts", path);

// Likes made here add to the count without names; fediverse accounts and other sites are named.
export const reactions = (fediverse: Fediverse, local = 0, elsewhere: Person[] = []): Reactions => ({
  count: local + fediverse.total + elsewhere.length,
  people: [...fediverse.items.map((reaction) => person(reaction.account)), ...elsewhere],
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
  const [results, remote, elsewhere] = await Promise.all([
    context.db.transaction([...statements, [`select likes from like_counts where slug = ?`, path]]),
    fediverseLikes(context, path),
    mentions(context, path, "like"),
  ]);
  const [row] = results[results.length - 1];
  return json({ likes: reactions(remote, Number(row?.likes ?? 0), elsewhere.map(mentionAuthor)), liked: on });
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
