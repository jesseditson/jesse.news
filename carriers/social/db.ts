import type { CarrierSql, CarrierSqlParam, CarrierSqlRow, CarrierSqlStatement } from "@archival/carrier";

const SCHEMA = [
  `create table if not exists comments (
    id integer primary key,
    slug text not null,
    parent_id integer,
    author text not null,
    body text not null,
    role text not null default 'reader',
    created_at text not null,
    user_id integer
  )`,
  `create index if not exists comments_by_slug on comments (slug, created_at)`,
  `create index if not exists comments_by_parent on comments (parent_id)`,
  // `synced` is the count the fediverse was last told; the schedule sends the rest.
  `create table if not exists like_counts (
    slug text primary key,
    likes integer not null default 0,
    synced integer
  )`,
  `create table if not exists user_likes (
    slug text not null,
    user_id integer not null,
    created_at text not null,
    primary key (slug, user_id)
  )`,
  `create index if not exists user_likes_by_user on user_likes (user_id)`,
  // `budget_hour` and `budget_used` count an account's changes in the current hour.
  `create table if not exists users (
    id integer primary key,
    name text not null unique collate nocase,
    role text not null default 'reader',
    created_at text not null,
    budget_hour text,
    budget_used integer not null default 0
  )`,
  `create table if not exists passkeys (
    id text primary key,
    user_id integer not null,
    public_key blob not null,
    counter integer not null default 0,
    transports text,
    created_at text not null,
    used_at text
  )`,
  `create index if not exists users_by_created on users (created_at)`,
  `create index if not exists passkeys_by_user on passkeys (user_id)`,
  `create table if not exists sessions (
    token_hash text primary key,
    user_id integer not null,
    created_at text not null,
    expires_at text not null
  )`,
  // A WebAuthn challenge between its options and the response that answers it; each is used once.
  `create table if not exists challenges (
    id text primary key,
    challenge text not null,
    kind text not null,
    name text,
    role text,
    expires_at text not null
  )`,
  `create table if not exists subscribers (
    id integer primary key,
    address text not null unique,
    token text not null unique,
    confirm_code text unique,
    status text not null default 'pending',
    created_at text not null,
    confirmed_at text,
    confirm_sent_at text
  )`,
  `create index if not exists subscribers_by_status on subscribers (status, confirmed_at)`,
  `create index if not exists subscribers_by_confirm_sent on subscribers (confirm_sent_at)`,
  `create table if not exists newsletter_posts (
    guid text primary key,
    title text not null,
    summary_html text not null default '',
    published_at text,
    seen_at text not null,
    notify integer not null default 1
  )`,
  `create index if not exists newsletter_posts_to_send on newsletter_posts (notify, seen_at)`,
  `create table if not exists deliveries (
    post_guid text not null,
    subscriber_id integer not null,
    sent_at text,
    attempts integer not null default 0,
    error text,
    primary key (post_guid, subscriber_id)
  )`,
];

export class Database {
  #sql: CarrierSql;
  static #ready: Promise<unknown> | null = null;

  constructor(sql: CarrierSql) {
    this.#sql = sql;
  }

  // Once per isolate: every statement is idempotent, and a fresh isolate may be the first to see the database.
  migrate(): Promise<unknown> {
    Database.#ready ??= this.#migrate().catch((error) => {
      Database.#ready = null;
      throw error;
    });
    return Database.#ready;
  }

  async #migrate(): Promise<void> {
    const tables = new Map(
      (
        await this.#sql.exec<{ name: string; sql: string }>(
          `select name, sql from sqlite_master where type = 'table' and name in ('boosts', 'comments', 'users')`,
        )
      ).map((table) => [table.name, table.sql]),
    );
    const comments = tables.get("comments");
    const users = tables.get("users");
    await this.#sql.transaction([
      ...SCHEMA.map((statement): CarrierSqlStatement => [statement]),
      // Databases deployed before accounts: local boosts became anonymous likes, and comments had no user.
      ...(tables.has("boosts")
        ? ([
            [`insert or ignore into like_counts (slug, likes) select slug, count(*) from boosts group by slug`],
            [`drop table boosts`],
          ] satisfies CarrierSqlStatement[])
        : []),
      ...(comments && !comments.includes("user_id")
        ? ([[`alter table comments add column user_id integer`]] satisfies CarrierSqlStatement[])
        : []),
      ...(users && !users.includes("budget_hour")
        ? ([
            [`alter table users add column budget_hour text`],
            [`alter table users add column budget_used integer not null default 0`],
          ] satisfies CarrierSqlStatement[])
        : []),
      [`create index if not exists comments_by_user on comments (user_id, created_at)`],
      [`create index if not exists comments_by_created on comments (created_at)`],
    ]);
  }

  all<T extends CarrierSqlRow>(sql: string, ...params: CarrierSqlParam[]): Promise<T[]> {
    return this.#sql.exec<T>(sql, ...params);
  }

  async one<T extends CarrierSqlRow>(sql: string, ...params: CarrierSqlParam[]): Promise<T | undefined> {
    return (await this.#sql.exec<T>(sql, ...params))[0];
  }

  // Several statements in one call, which is what the database meters.
  transaction(statements: CarrierSqlStatement[]): Promise<CarrierSqlRow[][]> {
    return this.#sql.transaction(statements);
  }

  async batch(statements: CarrierSqlStatement[]): Promise<void> {
    for (let i = 0; i < statements.length; i += 100) {
      await this.#sql.transaction(statements.slice(i, i + 100));
    }
  }
}

export const now = () => new Date().toISOString();

export function randomToken(bytes = 16): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return difference === 0;
}
