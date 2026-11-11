import type { CarrierFediverseAccount, CarrierPage, CarrierPageRequest, CarrierReply } from "@archival/carrier";
import { type Context, fail, json, postPaths, text } from "./http";

const MAX_PAGES = 5;
const TIMEOUT_MS = 5000;
const HANDLE = /^@?([^@\s/]+)@([a-z0-9.-]+\.[a-z]{2,})$/i;
const SERVER = /^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\/?$/i;

export interface Person {
  name: string;
  handle: string | null;
  url: string | null;
  icon: string | null;
}

export const person = (account: CarrierFediverseAccount): Person => ({
  name: account.name?.trim() || account.handle || new URL(account.id).hostname,
  handle: account.handle,
  url: account.url ?? account.id,
  icon: account.icon,
});

// Reads every page of a list, up to a bound, so one busy post can't stall a request.
export async function everything<T>(read: (page: CarrierPageRequest) => Promise<CarrierPage<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await read({ limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...result.items);
    if (!result.next) break;
    cursor = result.next;
  }
  return items;
}

export async function replies(context: Context, path: string): Promise<CarrierReply[]> {
  try {
    return await everything((page) => context.site.activitypub.replies(path, page));
  } catch (error) {
    console.error("fediverse replies", path, error);
    return [];
  }
}

// The site's federated objects live beside its actor: …/_archival/ap/actor and …/_archival/ap/objects/post/slug.
function objectId(actor: string, path: string | null): string {
  if (!path) return actor;
  const [object, file] = path.split("/");
  return actor.replace(/\/actor$/, `/objects/${encodeURIComponent(object)}/${encodeURIComponent(file)}`);
}

function publicHost(host: string): boolean {
  const name = host.toLowerCase();
  return !(
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local") ||
    name.endsWith(".internal") ||
    /^[\d.]+$/.test(name)
  );
}

async function subscribeTemplate(user: string, host: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resource = encodeURIComponent(`acct:${user}@${host}`);
    const response = await fetch(`https://${host}/.well-known/webfinger?resource=${resource}`, {
      headers: { accept: "application/jrd+json, application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const { links } = (await response.json()) as { links?: { rel?: string; template?: string }[] };
    const template = links?.find((entry) => entry.rel === "http://ostatus.org/schema/1.0/subscribe")?.template;
    return template?.startsWith("https://") && template.includes("{uri}") ? template : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// "@you@server" or just "server", which skips the lookup and assumes Mastodon's interaction page.
function parseAccount(input: string): { user: string | null; host: string } | null {
  const handle = HANDLE.exec(input);
  const server = handle ? null : SERVER.exec(input);
  const host = (handle?.[2] ?? server?.[1])?.toLowerCase();
  return host && publicHost(host) ? { user: handle?.[1] ?? null, host } : null;
}

export async function interact(context: Context): Promise<Response> {
  const parsed = parseAccount(text(context.params.get("handle")));
  if (!parsed) return fail("Enter your handle, like @you@mastodon.social, or just your server.");
  const path = context.params.get("path") || null;
  if (path && !postPaths(context).has(path)) return fail("That post doesn't exist.", 404);

  const actor = await context.site.activitypub.account().catch(() => null);
  if (!actor) return fail("This site isn't on the fediverse yet.", 404);

  const { user, host } = parsed;
  const target = encodeURIComponent(objectId(actor.id, path));
  const template = user ? await subscribeTemplate(user, host) : null;
  const url = template ? template.replace("{uri}", target) : `https://${host}/authorize_interaction?uri=${target}`;
  return json({ url });
}

export async function account(context: Context, emailSubscribers: number): Promise<Response> {
  let fediverse = null;
  try {
    fediverse = await context.site.activitypub.account();
  } catch (error) {
    console.error("fediverse account", error);
  }
  return json(
    {
      handle: fediverse?.handle ?? null,
      url: fediverse?.url ?? null,
      followers: (fediverse?.followers ?? 0) + emailSubscribers,
      fediverseFollowers: fediverse?.followers ?? 0,
      emailSubscribers,
    },
    200,
    "public, max-age=300",
  );
}
