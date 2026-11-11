import type { CarrierATProto, CarrierATProtoAccount, CarrierATProtoCounts, CarrierATProtoReply } from "@archival/carrier";
import { everything, type Person } from "./fediverse";
import type { Env } from "./http";

export interface Named {
  total: number;
  people: Person[];
}

const SHOWN = 24;
const NONE: CarrierATProtoCounts = { likes: 0, reposts: 0, replies: 0 };

// `archival run` through 0.27.1 has no `site.atproto`, which reads as a site Bluesky hasn't touched.
const atproto = (env: Env): CarrierATProto | undefined => env.site.atproto;

export const blueskyPerson = (account: CarrierATProtoAccount): Person => ({
  name: account.name?.trim() || account.handle || account.did,
  handle: account.handle ? `@${account.handle}` : null,
  url: account.url,
  icon: account.avatar,
});

async function reacted(env: Env, kind: "likes" | "reposts", path: string): Promise<Named> {
  const network = atproto(env);
  if (!network) return { total: 0, people: [] };
  try {
    const page = await network[kind](path, { limit: SHOWN });
    return { total: page.total, people: page.items.map((reaction) => blueskyPerson(reaction.account)) };
  } catch (error) {
    console.error(`bluesky ${kind}`, path, error);
    return { total: 0, people: [] };
  }
}

export const blueskyLikes = (env: Env, path: string) => reacted(env, "likes", path);
export const blueskyReposts = (env: Env, path: string) => reacted(env, "reposts", path);

export async function blueskyReplies(env: Env, path: string): Promise<CarrierATProtoReply[]> {
  const network = atproto(env);
  if (!network) return [];
  try {
    return await everything((page) => network.replies(path, page));
  } catch (error) {
    console.error("bluesky replies", path, error);
    return [];
  }
}

export async function blueskyCounts(env: Env, paths: string[]): Promise<CarrierATProtoCounts[]> {
  const network = atproto(env);
  if (!network) return paths.map(() => NONE);
  try {
    return await network.counts(paths);
  } catch (error) {
    console.error("bluesky counts", error);
    return paths.map(() => NONE);
  }
}
