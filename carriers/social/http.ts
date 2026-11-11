import type { CarrierBody, CarrierObjects, CarrierParams, CarrierSite } from "@archival/carrier";
import { Database, sameSecret } from "./db";

export type Fields = Record<string, unknown>;

// What every handler gets, including a scheduled run, which has no request.
export interface Env {
  objects: CarrierObjects;
  site: CarrierSite;
  db: Database;
}

export interface Context extends Env {
  params: CarrierParams;
  // Null when the request carried no body, which is every GET.
  body: Fields | null;
}

export function json(body: unknown, status = 200, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
}

export const fail = (error: string, status = 400) => json({ error }, status);

export function fields(body: CarrierBody): Fields | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Fields) : null;
}

export const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export const siteURL = (context: Env) => context.site.url.replace(/\/+$/, "");

export const isAdmin = (context: Env, token: unknown) => {
  const expected = context.objects.site.admin_token?.trim();
  return !!expected && typeof token === "string" && sameSecret(token, expected);
};

export function postPaths(context: Env): Set<string> {
  return new Set(context.objects.post.map((post) => post.path));
}
