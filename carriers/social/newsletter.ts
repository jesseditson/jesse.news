import { now, randomToken } from "./db";
import { parseFeed, type FeedItem } from "./feed";
import { type Context, type Env, fail, json, siteURL, text } from "./http";

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const RESEND_AFTER_MS = 10 * 60 * 1000;
// Confirmations go to any address typed in, so caps keep the form from mailing strangers in bulk.
const CONFIRMATIONS_PER_HOUR = 3;
const CONFIRMATIONS_PER_DAY = 10;
// Archival sends at most 100 emails an hour; 20 a run, every 15 minutes, leaves room for confirmations.
const EMAILS_PER_RUN = 20;
const MAX_ATTEMPTS = 3;
// A post dated this long before it first shows up was imported or backdated, so it isn't news.
const NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Subscriber = {
  id: number;
  address: string;
  token: string;
  status: "pending" | "confirmed" | "removed";
  confirm_sent_at: string | null;
};

type Pending = {
  guid: string;
  title: string;
  summary_html: string;
  subscriber_id: number;
  address: string;
  token: string;
};

interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function parseEmail(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  return EMAIL.test(address) && address.length <= 320 ? address : null;
}

const link = (context: Env, action: string, query: Record<string, string>) =>
  `${siteURL(context)}/carriers/social?${new URLSearchParams({ action, ...query })}`;

const siteName = (context: Env) => context.objects.site.name?.trim() || new URL(siteURL(context)).hostname;

async function send(context: Env, email: Email): Promise<{ ok: boolean; error?: string }> {
  const from = context.objects.site.email_from?.trim();
  try {
    await context.site.email.send({ ...(from ? { from } : {}), ...email });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function confirmation(context: Env, address: string, code: string): Email {
  const url = link(context, "confirm", { code });
  const site = siteName(context);
  return {
    to: address,
    subject: `Confirm new posts from ${site}`,
    text: `Tap the link to get an email when there's a new post on ${site}:\n\n${url}\n\nIf you didn't ask for this, ignore this email and nothing will be sent.`,
    html: `<p>Tap the link to get an email when there's a new post on ${escapeHTML(site)}:</p><p><a href="${url}">Send me new posts</a></p><p style="color:#666;font-size:13px">If you didn't ask for this, ignore this email and nothing will be sent.</p>`,
  };
}

export async function subscribe(context: Context): Promise<Response> {
  const body = context.body ?? {};
  const address = parseEmail(text(body.address));
  if (!address) return fail("That doesn't look like an email address.");

  const { db } = context;
  const [[found], [recent]] = await db.transaction([
    [`select * from subscribers where address = ?`, address],
    [
      `select count(*) as day, coalesce(sum(confirm_sent_at > ?), 0) as hour from subscribers where confirm_sent_at > ?`,
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    ],
  ]);
  const existing = found as Subscriber | undefined;
  if (existing?.status === "confirmed") return json({ status: "confirmed", address });

  // Each request for an unconfirmed address issues a fresh token, so an earlier requester can't keep one.
  const token = randomToken(18);
  const code = randomToken(16);
  const stamp = now();
  const tooSoon =
    !!existing?.confirm_sent_at && Date.now() - new Date(existing.confirm_sent_at).getTime() < RESEND_AFTER_MS;
  if (!tooSoon && (Number(recent?.hour) >= CONFIRMATIONS_PER_HOUR || Number(recent?.day) >= CONFIRMATIONS_PER_DAY)) {
    return fail("Lots of sign-ups right now. Try again later.", 429);
  }

  if (existing) {
    await db.all(
      `update subscribers set token = ?, confirm_code = ?, status = 'pending', confirm_sent_at = ? where id = ?`,
      token,
      code,
      tooSoon ? existing.confirm_sent_at : stamp,
      existing.id,
    );
  } else {
    await db.all(
      `insert into subscribers (address, token, confirm_code, status, created_at, confirm_sent_at) values (?, ?, ?, 'pending', ?, ?)`,
      address,
      token,
      code,
      stamp,
      stamp,
    );
  }

  if (!tooSoon) {
    const sent = await send(context, confirmation(context, address, code));
    if (!sent.ok) {
      console.error("confirmation failed", sent.error);
      return fail("We couldn't send the confirmation. Try again in a bit.", 502);
    }
  }
  return json({ status: "pending", address, token });
}

export async function confirm(context: Context): Promise<string> {
  const code = context.params.get("code") ?? "";
  const confirmed = code
    ? await context.db.all(
        `update subscribers set status = 'confirmed', confirmed_at = ?, confirm_code = null
          where confirm_code = ? and status = 'pending' returning id`,
        now(),
        code,
      )
    : [];
  return `redirect:${siteURL(context)}/#newsletter-${confirmed.length ? "confirmed" : "expired"}`;
}

export async function unsubscribe(context: Context): Promise<Response | string> {
  const fromLink = context.body === null;
  const token = fromLink ? context.params.get("token") ?? "" : text(context.body?.token);
  const removed = token
    ? await context.db.all(
        `update subscribers set status = 'removed', confirm_code = null where token = ? returning id`,
        token,
      )
    : [];
  if (fromLink) return `redirect:${siteURL(context)}/#newsletter-removed`;
  return json({ ok: removed.length > 0 });
}

export async function status(context: Context): Promise<Response> {
  const token = context.params.get("token") ?? "";
  const row = token
    ? await context.db.one<{ status: string }>(`select status from subscribers where token = ?`, token)
    : undefined;
  return json({ status: row?.status ?? "unknown" });
}

export async function subscriberCount(context: Env): Promise<number> {
  const row = await context.db.one<{ n: number }>(`select count(*) as n from subscribers where status = 'confirmed'`);
  return Number(row?.n ?? 0);
}

const escapeHTML = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

async function recordFeed(context: Env, items: FeedItem[]): Promise<void> {
  const { db } = context;
  const first = Number((await db.one<{ n: number }>(`select count(*) as n from newsletter_posts`))?.n ?? 0) === 0;
  const seen = now();
  // The first run only learns what's already published, so nobody gets the back catalogue.
  await db.batch(
    items.map((item) => {
      const fresh = !item.publishedAt || Date.parse(seen) - Date.parse(item.publishedAt) < NEWS_WINDOW_MS;
      return [
        `insert or ignore into newsletter_posts (guid, title, summary_html, published_at, seen_at, notify) values (?, ?, ?, ?, ?, ?)`,
        item.guid,
        item.title,
        item.summaryHTML,
        item.publishedAt,
        seen,
        !first && fresh ? 1 : 0,
      ];
    }),
  );
}

function compose(site: string, posts: Pending[], unsubscribe: string): Email {
  const to = posts[0].address;
  const footer =
    `<p style="font:12px/1.5 system-ui,sans-serif;color:#888">You asked for new posts from ${escapeHTML(site)}. ` +
    `<a href="${unsubscribe}" style="color:#888">Unsubscribe</a></p>`;
  if (posts.length === 1) {
    const [post] = posts;
    // The site derives a post's title from its leading heading, so that heading already carries it.
    const titled = /^\s*<h[1-6]\b/i.test(post.summary_html);
    return {
      to,
      subject: post.title,
      text: `${titled ? "" : `${post.title}\n\n`}${plain(post.summary_html)}\n\n${post.guid}\n\n--\nUnsubscribe: ${unsubscribe}`,
      html:
        (titled ? "" : `<h1 style="font:600 20px/1.3 system-ui,sans-serif;margin:0 0 12px">${escapeHTML(post.title)}</h1>`) +
        `<div style="font:16px/1.5 system-ui,sans-serif;color:#222">${post.summary_html}</div>` +
        `<p style="font:16px/1.5 system-ui,sans-serif"><a href="${post.guid}">Read it on ${escapeHTML(site)}</a></p>` +
        footer,
    };
  }
  const list = posts.map((post) => `- ${post.title}\n  ${post.guid}`).join("\n");
  const items = posts
    .map((post) => `<li style="margin:0 0 8px"><a href="${post.guid}">${escapeHTML(post.title)}</a></li>`)
    .join("");
  return {
    to,
    subject: `${posts.length} new posts on ${site}`,
    text: `${list}\n\n--\nUnsubscribe: ${unsubscribe}`,
    html: `<ul style="font:16px/1.5 system-ui,sans-serif;padding-left:20px">${items}</ul>${footer}`,
  };
}

export interface Delivery {
  sent: number;
  failed: number;
  waiting: number;
}

// Learns new posts from the published feed and emails them to confirmed subscribers.
export async function deliver(env: Env): Promise<Delivery> {
  const { db } = env;

  const response = await fetch(`${siteURL(env)}/feed.xml`, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`feed responded ${response.status}`);
  const feed = parseFeed(await response.text());
  await recordFeed(env, feed.items);

  const pending = await db.all<Pending>(
    `select p.guid, p.title, p.summary_html, s.id as subscriber_id, s.address, s.token
       from newsletter_posts p
       join subscribers s on s.status = 'confirmed' and s.confirmed_at <= p.seen_at
       left join deliveries d on d.post_guid = p.guid and d.subscriber_id = s.id
      where p.notify = 1 and d.sent_at is null and coalesce(d.attempts, 0) < ?
      order by s.id, p.seen_at
      limit 2000`,
    MAX_ATTEMPTS,
  );

  const bySubscriber = new Map<number, Pending[]>();
  for (const row of pending) {
    const id = Number(row.subscriber_id);
    bySubscriber.set(id, [...(bySubscriber.get(id) ?? []), row]);
  }

  const site = feed.title || siteName(env);
  const batches = [...bySubscriber].slice(0, EMAILS_PER_RUN);
  const stamp = now();
  let sent = 0;
  const statements: [string, ...(string | number | null)[]][] = [];
  for (const [subscriberId, posts] of batches) {
    const result = await send(env, compose(site, posts, link(env, "unsubscribe", { token: posts[0].token })));
    if (result.ok) sent++;
    else console.error(posts[0].address, result.error);
    for (const post of posts) {
      statements.push([
        `insert into deliveries (post_guid, subscriber_id, sent_at, attempts, error) values (?, ?, ?, 1, ?)
         on conflict (post_guid, subscriber_id) do update set
           sent_at = excluded.sent_at, attempts = deliveries.attempts + 1, error = excluded.error`,
        post.guid,
        subscriberId,
        result.ok ? stamp : null,
        result.ok ? null : result.error ?? "failed",
      ]);
    }
  }
  await db.batch(statements);
  return { sent, failed: batches.length - sent, waiting: bySubscriber.size - batches.length };
}
