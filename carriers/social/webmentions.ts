import type { CarrierWebmention, CarrierWebmentionCounts, CarrierWebmentionKind } from "@archival/carrier";
import { everything, type Person } from "./fediverse";
import type { Env } from "./http";

const NONE: CarrierWebmentionCounts = { replies: 0, likes: 0, reposts: 0, bookmarks: 0, mentions: 0 };

const COUNTED: Record<CarrierWebmentionKind, keyof CarrierWebmentionCounts> = {
  reply: "replies",
  like: "likes",
  repost: "reposts",
  bookmark: "bookmarks",
  mention: "mentions",
};

// A plain link to a post, or a bookmark of it: listed on its own rather than as a comment or reaction.
export interface Mention {
  url: string;
  title: string | null;
  kind: "mention" | "bookmark";
  author: Person;
  createdAt: string;
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

// Each entry on the Site's blocklist is a domain, or a URL on one, and covers its subdomains too.
function blockedHosts(env: Env): string[] {
  return env.objects.site.webmention_blocklist
    .map(({ domain }) => {
      const value = domain?.trim().toLowerCase() ?? "";
      return /^[a-z][a-z0-9+.-]*:\/\//.test(value) ? hostOf(value) : value.split("/")[0];
    })
    .filter((host): host is string => !!host);
}

function visible(env: Env): (mention: CarrierWebmention) => boolean {
  const blocked = blockedHosts(env);
  return (mention) =>
    ![mention.source, mention.url, mention.author?.url ?? null].some((url) => {
      const host = hostOf(url);
      return !!host && blocked.some((domain) => host === domain || host.endsWith(`.${domain}`));
    });
}

export async function mentions(env: Env, path: string, kind?: CarrierWebmentionKind): Promise<CarrierWebmention[]> {
  try {
    const found = await everything((page) => env.site.webmentions.list(path, { ...page, ...(kind ? { kind } : {}) }));
    return found.filter(visible(env));
  } catch (error) {
    console.error("webmentions", path, error);
    return [];
  }
}

function tally(found: CarrierWebmention[]): CarrierWebmentionCounts {
  const counts = { ...NONE };
  for (const mention of found) counts[COUNTED[mention.kind]] += 1;
  return counts;
}

// The platform's counts include blocked sites, so a post with any mentions is recounted from its list.
export async function mentionCounts(env: Env, paths: string[]): Promise<CarrierWebmentionCounts[]> {
  try {
    const counts = await env.site.webmentions.counts(paths);
    if (!blockedHosts(env).length) return counts;
    return await Promise.all(
      counts.map(async (count, i) =>
        Object.values(count).some(Boolean) ? tally(await mentions(env, paths[i])) : count,
      ),
    );
  } catch (error) {
    console.error("webmention counts", error);
    return paths.map(() => NONE);
  }
}

export const mentionAuthor = (mention: CarrierWebmention): Person => ({
  name: mention.author?.name?.trim() || new URL(mention.url).hostname,
  handle: null,
  url: mention.author?.url ?? mention.url,
  icon: mention.author?.photo ?? null,
});

export const isListed = (mention: CarrierWebmention) => mention.kind === "mention" || mention.kind === "bookmark";

export const toMention = (mention: CarrierWebmention): Mention => ({
  url: mention.url,
  title: mention.name,
  kind: mention.kind === "bookmark" ? "bookmark" : "mention",
  author: mentionAuthor(mention),
  createdAt: mention.published ?? mention.received,
});
