export interface FeedItem {
  guid: string;
  title: string;
  summaryHTML: string;
  publishedAt: string | null;
}

export interface Feed {
  title: string;
  items: FeedItem[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });

function tag(xml: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!match) return "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(match[1]);
  return cdata ? cdata[1].replace(/\]\]\]\]><!\[CDATA\[>/g, "]]>") : decode(match[1]).trim();
}

// Reads the RSS this site publishes at /feed.xml.
export function parseFeed(xml: string): Feed {
  const channel = xml.split(/<item\b/i)[0];
  const items = Array.from(xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi), ([, body]) => {
    const published = tag(body, "pubDate");
    const date = published ? new Date(published) : null;
    return {
      guid: tag(body, "guid") || tag(body, "link"),
      title: tag(body, "title"),
      summaryHTML: tag(body, "description"),
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    };
  }).filter((item) => item.guid);
  return { title: tag(channel, "title"), items };
}
