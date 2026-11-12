import type { Carrier, CarrierScheduled, CarrierSite, SiteObjects } from "@archival/carrier";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 10_000_000;
// A request uses a stored copy younger than this; the schedule refreshes hourly.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Past events are kept this long, so a calendar still shows last week's meetups.
const KEEP_PAST_MS = 30 * 24 * 60 * 60 * 1000;
// Two events from different feeds starting within this window with the same title are one event.
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

interface Feed {
  name: string;
  url: string;
}

interface Calendar {
  name: string;
  description: string;
  feeds: Feed[];
}

interface Loaded {
  feed: Feed;
  body: string | null;
  fetchedAt: number | null;
  error: string | null;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface CalendarEvent {
  feed: Feed;
  lines: string[];
  uid: string;
  summary: string;
  url: string;
  location: string;
  status: string;
  start: number;
  end: number;
  allDay: boolean;
}

// The feeds keep the order the editor lists them in: when two feeds list the same
// meetup, the copy from the feed listed first is kept.
function calendarFrom(objects: SiteObjects): Calendar {
  const config = objects.website_clubs;
  const feeds: Feed[] = [];
  for (const row of config?.feed ?? []) {
    const url = row.url?.trim() ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(parsed.protocol) || feeds.some((feed) => feed.url === url)) continue;
    feeds.push({ name: row.name?.trim() || parsed.hostname, url });
  }
  return { name: config?.name?.trim() ?? "", description: config?.description?.trim() ?? "", feeds };
}

// ---------------------------------------------------------------- fetching

class FeedError extends Error {}

async function fetchFeed(feed: Feed, userAgent: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(feed.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/calendar, */*;q=0.5", "user-agent": userAgent },
    });
    if (!response.ok) throw new FeedError(`responded ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_FEED_BYTES) throw new FeedError("too large");
    const text = await response.text();
    if (text.length > MAX_FEED_BYTES) throw new FeedError("too large");
    // Only a whole calendar replaces the stored copy, so a truncated or HTML answer
    // never empties the merged feed.
    if (!/^\uFEFF?BEGIN:VCALENDAR/.test(text.trimStart()) || !/END:VCALENDAR\s*$/.test(text)) {
      throw new FeedError("not a complete iCalendar file");
    }
    return text;
  } catch (error) {
    if (error instanceof FeedError) throw error;
    throw new FeedError(controller.signal.aborted ? "timed out" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

const TABLE = `CREATE TABLE IF NOT EXISTS website_clubs_feeds (
  url TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
)`;

const placeholders = (feeds: Feed[]) => feeds.map(() => "?").join(", ");

async function readStored(site: CarrierSite, feeds: Feed[]): Promise<Map<string, { body: string; fetchedAt: number }>> {
  const stored = new Map<string, { body: string; fetchedAt: number }>();
  if (feeds.length === 0) return stored;
  try {
    await site.sql.exec(TABLE);
    const rows = await site.sql.exec<{ url: string; body: string; fetched_at: number }>(
      `SELECT url, body, fetched_at FROM website_clubs_feeds WHERE url IN (${placeholders(feeds)})`,
      ...feeds.map((feed) => feed.url),
    );
    for (const row of rows) stored.set(row.url, { body: row.body, fetchedAt: row.fetched_at });
  } catch {
    // No database (preview, `archival run`, or a plan without one): fetch every time.
  }
  return stored;
}

async function store(site: CarrierSite, url: string, body: string, fetchedAt: number): Promise<void> {
  try {
    await site.sql.exec(
      "INSERT INTO website_clubs_feeds (url, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
      url,
      body,
      fetchedAt,
    );
  } catch {
    // Same as above: without a database the merged feed is built live.
  }
}

async function prune(site: CarrierSite, feeds: Feed[]): Promise<void> {
  try {
    await site.sql.exec(TABLE);
    if (feeds.length === 0) await site.sql.exec("DELETE FROM website_clubs_feeds");
    else {
      await site.sql.exec(
        `DELETE FROM website_clubs_feeds WHERE url NOT IN (${placeholders(feeds)})`,
        ...feeds.map((feed) => feed.url),
      );
    }
  } catch {
    // No database: nothing stored to prune.
  }
}

// A feed that can't be fetched falls back to its last good copy, so one organizer's
// site being down doesn't drop their events from everyone's calendar.
async function loadFeeds(site: CarrierSite, feeds: Feed[], maxAgeMs: number, now: number): Promise<Loaded[]> {
  const stored = await readStored(site, feeds);
  const userAgent = `WebsiteClubs/1.0 (+${site.url || "https://jesse.news"}/carriers/website-clubs)`;
  return Promise.all(
    feeds.map(async (feed): Promise<Loaded> => {
      const copy = stored.get(feed.url);
      if (copy && now - copy.fetchedAt < maxAgeMs) {
        return { feed, body: copy.body, fetchedAt: copy.fetchedAt, error: null };
      }
      try {
        const body = trim(feed, await fetchFeed(feed, userAgent), now);
        await store(site, feed.url, body, now);
        return { feed, body, fetchedAt: now, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        console.error(`website-clubs: ${feed.url} ${message}`);
        return { feed, body: copy?.body ?? null, fetchedAt: copy?.fetchedAt ?? null, error: message };
      }
    }),
  );
}

// ---------------------------------------------------------------- parsing

function unfold(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((line) => line.length > 0);
}

function parseProperty(line: string): Property {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  const head = colon === -1 ? line : line.slice(0, colon);
  const value = colon === -1 ? "" : line.slice(colon + 1);
  const [name, ...rawParams] = head.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const eq = raw.indexOf("=");
    if (eq > 0) params[raw.slice(0, eq).toUpperCase()] = raw.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// The offset of `timeZone` from UTC at `ms`, in milliseconds.
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ms;
}

// An iCalendar date or date-time as milliseconds since the epoch. Floating times, and
// zones the runtime doesn't know, are read as UTC: close enough to sort and dedupe by.
function toEpoch(property: Property): { ms: number; allDay: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(property.value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const wall = Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
  if (h === undefined || property.params.VALUE === "DATE") return { ms: wall, allDay: true };
  const tzid = property.params.TZID;
  if (z || !tzid) return { ms: wall, allDay: false };
  try {
    let ms = wall - zoneOffset(wall, tzid);
    ms = wall - zoneOffset(ms, tzid);
    return { ms, allDay: false };
  } catch {
    return { ms: wall, allDay: false };
  }
}

function durationMs(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, w, d, h, m, s] = match;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86_400 + +(h ?? 0) * 3600 + +(m ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
}

interface Parsed {
  events: CalendarEvent[];
  timezones: Map<string, string[]>;
}

function parseCalendar(feed: Feed, body: string): Parsed {
  const events: CalendarEvent[] = [];
  const timezones = new Map<string, string[]>();
  const stack: string[] = [];
  let block: string[] = [];

  for (const line of unfold(body)) {
    const property = parseProperty(line);
    if (property.name === "BEGIN") {
      const component = property.value.toUpperCase();
      stack.push(component);
      if (stack.length === 2 && (component === "VEVENT" || component === "VTIMEZONE")) block = [];
      // Feeds' alarms would set reminders on every subscriber's calendar.
      if (stack.includes("VALARM")) continue;
      if (stack.length >= 2) block.push(line);
      continue;
    }
    if (property.name === "END") {
      const component = stack.pop();
      if (component === "VALARM" || stack.includes("VALARM")) continue;
      if (stack.length >= 1 && block.length) block.push(line);
      if (stack.length === 1 && component === "VTIMEZONE") {
        const tzid = block.map(parseProperty).find((p) => p.name === "TZID")?.value;
        if (tzid && !timezones.has(tzid)) timezones.set(tzid, block);
      }
      if (stack.length === 1 && component === "VEVENT") {
        const event = toEvent(feed, block);
        if (event) events.push(event);
      }
      continue;
    }
    if (stack.length >= 2 && !stack.includes("VALARM")) block.push(line);
  }
  return { events, timezones };
}

function toEvent(feed: Feed, lines: string[]): CalendarEvent | null {
  const props = new Map<string, Property>();
  for (const line of lines.slice(1, -1)) {
    const property = parseProperty(line);
    if (!props.has(property.name)) props.set(property.name, property);
  }
  const uid = props.get("UID")?.value.trim();
  const dtstart = props.get("DTSTART");
  if (!uid || !dtstart) return null;
  // Recurring events aren't expanded here; the feeds merged so far list each meetup on its own.
  const start = toEpoch(dtstart);
  if (!start) return null;
  const dtend = props.get("DTEND");
  const duration = props.get("DURATION");
  const end =
    (dtend && toEpoch(dtend)?.ms) ??
    (duration && durationMs(duration.value) !== null ? start.ms + (durationMs(duration.value) as number) : null) ??
    start.ms + (start.allDay ? 86_400_000 : 0);

  const text = (name: string) => unescapeText(props.get(name)?.value ?? "").trim();

  return {
    feed,
    lines,
    uid,
    summary: text("SUMMARY"),
    url: props.get("URL")?.value.trim() ?? "",
    location: text("LOCATION"),
    status: (props.get("STATUS")?.value ?? "CONFIRMED").trim().toUpperCase(),
    start: start.ms,
    end,
    allDay: start.allDay,
  };
}

function usedZones(events: CalendarEvent[], timezones: Map<string, string[]>): Map<string, string[]> {
  const used = new Set(events.flatMap((e) => e.lines.map(parseProperty).map((p) => p.params.TZID).filter(Boolean)));
  return new Map([...timezones].filter(([tzid]) => used.has(tzid)));
}

// Stored copies keep only events the merged calendar can still show: a feed with years
// of history doesn't fit in one row.
function trim(feed: Feed, body: string, now: number): string {
  const { events, timezones } = parseCalendar(feed, body);
  const kept = events.filter((event) => event.end >= now - KEEP_PAST_MS);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...[...usedZones(kept, timezones).values()].flat(),
    ...kept.flatMap((event) => event.lines),
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- merging

function normalizeURL(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(cancel+ed|tentative)\s*:\s*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function merge(loaded: Loaded[], now: number): { events: CalendarEvent[]; timezones: Map<string, string[]> } {
  const events: CalendarEvent[] = [];
  const timezones = new Map<string, string[]>();
  const uids = new Set<string>();
  const urls = new Set<string>();
  const slots = new Map<string, number[]>();

  for (const { feed, body } of loaded) {
    if (!body) continue;
    const parsed = parseCalendar(feed, body);
    // URL and title only match against earlier feeds: within one feed, a series can
    // share a single page and a title.
    const feedURLs: string[] = [];
    const feedSlots: [string, number][] = [];
    for (const event of parsed.events) {
      if (event.end < now - KEEP_PAST_MS) continue;
      const url = event.url ? normalizeURL(event.url) : "";
      const title = normalizeTitle(event.summary);
      const starts = title ? slots.get(title) ?? [] : [];
      const duplicate =
        uids.has(event.uid) ||
        (url !== "" && urls.has(url)) ||
        starts.some((start) => Math.abs(start - event.start) <= DEDUPE_WINDOW_MS);
      if (duplicate) continue;
      uids.add(event.uid);
      if (url) feedURLs.push(url);
      if (title) feedSlots.push([title, event.start]);
      events.push(event);
    }
    for (const url of feedURLs) urls.add(url);
    for (const [title, start] of feedSlots) slots.set(title, [...(slots.get(title) ?? []), start]);
    for (const [tzid, block] of parsed.timezones) {
      if (!timezones.has(tzid)) timezones.set(tzid, block);
    }
  }
  events.sort((a, b) => a.start - b.start || a.uid.localeCompare(b.uid));
  return { events, timezones: usedZones(events, timezones) };
}

// ---------------------------------------------------------------- output

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const encoder = new TextEncoder();

// Lines longer than 75 octets are folded, without splitting a character.
function fold(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

function published(event: CalendarEvent, now: number): string[] {
  const [begin, ...rest] = event.lines;
  const end = rest.pop() as string;
  const dtstamp = rest.some((line) => parseProperty(line).name === "DTSTAMP") ? [] : [`DTSTAMP:${stamp(now)}`];
  return [begin, ...dtstamp, ...rest, `X-WEBSITE-CLUBS-SOURCE:${escapeText(event.feed.name)}`, end];
}

function render(calendar: Calendar, events: CalendarEvent[], timezones: Map<string, string[]>, selfURL: string): string {
  const now = Date.now();
  const name = escapeText(calendar.name);
  const description = escapeText(calendar.description);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//jesse.news//Website Clubs//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...(name ? [`NAME:${name}`, `X-WR-CALNAME:${name}`] : []),
    ...(description ? [`DESCRIPTION:${description}`, `X-WR-CALDESC:${description}`] : []),
    `URL:${selfURL}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    ...[...timezones.values()].flat(),
    ...events.flatMap((event) => published(event, now)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

function summary(calendar: Calendar, loaded: Loaded[], events: CalendarEvent[]) {
  return {
    name: calendar.name,
    feeds: loaded.map(({ feed, fetchedAt, error }) => ({
      name: feed.name,
      url: feed.url,
      events: events.filter((event) => event.feed === feed).length,
      fetched_at: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      error,
    })),
    events: events.map((event) => ({
      uid: event.uid,
      summary: event.summary,
      start: new Date(event.start).toISOString(),
      end: new Date(event.end).toISOString(),
      all_day: event.allDay,
      status: event.status,
      url: event.url,
      location: event.location,
      source: event.feed.name,
    })),
  };
}

const HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=900",
};

const carrier: Carrier = async (params, _body, objects, site) => {
  const now = Date.now();
  const calendar = calendarFrom(objects);
  const loaded = await loadFeeds(site, calendar.feeds, MAX_AGE_MS, now);
  const { events, timezones } = merge(loaded, now);

  if (params.get("format") === "json") {
    return new Response(JSON.stringify(summary(calendar, loaded, events)), {
      headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" },
    });
  }
  if (loaded.length > 0 && !loaded.some((entry) => entry.body)) {
    return new Response("No feed could be read. Try again in a bit.", {
      status: 503,
      headers: { ...HEADERS, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const selfURL = `${site.url || "https://jesse.news"}/carriers/website-clubs`;
  return new Response(render(calendar, events, timezones, selfURL), {
    headers: {
      ...HEADERS,
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="website-clubs.ics"',
    },
  });
};

export default carrier;

// Hourly (the schedule in package.json): refresh every feed's stored copy.
export const scheduled: CarrierScheduled = async (objects, site) => {
  const { feeds } = calendarFrom(objects);
  await prune(site, feeds);
  const loaded = await loadFeeds(site, feeds, 0, Date.now());
  if (loaded.length > 0 && loaded.every((entry) => entry.error)) throw new Error("website-clubs: every feed failed");
};

