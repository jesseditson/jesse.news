import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { CarrierSqlStatement } from "@archival/carrier";
import { now, randomToken } from "./db";
import { type Context, type Env, fail, isAdmin, json, siteURL, text } from "./http";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = 180 * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_NAME = 40;
// Nothing proves a passkey's holder is a person, so these bound what a script can do, sized for a small site.
const SIGNUPS_PER_HOUR = 3;
const SIGNUPS_PER_DAY = 10;
const OPEN_CHALLENGES = 10;
const CHANGES_PER_HOUR = 60;

export interface User {
  id: number;
  name: string;
  role: string;
}

type UserRow = { id: number; name: string; role: string };

const toUser = (row: UserRow): User => ({ id: Number(row.id), name: row.name, role: row.role });

function relyingParty(env: Env) {
  const url = new URL(siteURL(env));
  return { id: url.hostname, origin: url.origin, name: env.objects.site.name?.trim() || url.hostname };
}

export function cleanName(raw: unknown): string | null {
  const name = text(raw).normalize("NFC").replace(/\s+/g, " ");
  if (name.length < 2 || name.length > MAX_NAME || /[\p{C}<>]/u.test(name)) return null;
  return /[\p{L}\p{N}]/u.test(name) ? name : null;
}

// The site's own names belong to whoever holds the admin token.
const reserved = (env: Env, name: string) =>
  [env.objects.site.author, env.objects.site.name].some((taken) => taken?.trim().toLowerCase() === name.toLowerCase());

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const expiry = () => new Date(Date.now() + SESSION_MS).toISOString();

// Sessions travel in request bodies, since a carrier can't read cookies; only their hashes are stored.
async function newSession(): Promise<{ token: string; hash: string }> {
  const token = randomToken(32);
  return { token, hash: await hash(token) };
}

export async function currentUser(context: Context): Promise<User | null> {
  const token = text(context.body?.session);
  if (!token) return null;
  const tokenHash = await hash(token);
  const row = await context.db.one<UserRow & { expires_at: string }>(
    `select u.id, u.name, u.role, s.expires_at from sessions s join users u on u.id = s.user_id
      where s.token_hash = ? and s.expires_at > ?`,
    tokenHash,
    now(),
  );
  if (!row) return null;
  // Sliding expiry, written at most once a day per session.
  if (Date.parse(row.expires_at) < Date.now() + SESSION_MS - DAY_MS) {
    await context.db.all(`update sessions set expires_at = ? where token_hash = ?`, expiry(), tokenHash);
  }
  return toUser(row);
}

// A signed-in account that hasn't spent its hourly changes, so no one account can use up the site's database writes.
export async function actingUser(context: Context, signedOut = "Sign in first."): Promise<User | Response> {
  const user = await currentUser(context);
  if (!user) return fail(signedOut, 401);
  const hour = new Date().toISOString().slice(0, 13);
  const [spent] = await context.db.all(
    `update users set budget_used = case when budget_hour = ? then budget_used + 1 else 1 end, budget_hour = ?
      where id = ? and (budget_hour is not ? or budget_used < ?) returning budget_used`,
    hour,
    hour,
    user.id,
    hour,
    CHANGES_PER_HOUR,
  );
  return spent ? user : fail("That's a lot of changes. Try again in a little while.", 429);
}

async function issueChallenge(env: Env, kind: string, challenge: string, name: string | null = null, role: string | null = null) {
  const id = randomToken(16);
  const stamp = now();
  const [, [open]] = await env.db.transaction([
    [`delete from challenges where expires_at <= ?`, stamp],
    [`select count(*) as n from challenges`],
  ]);
  if (Number(open?.n ?? 0) >= OPEN_CHALLENGES) return null;
  await env.db.all(
    `insert into challenges (id, challenge, kind, name, role, expires_at) values (?, ?, ?, ?, ?, ?)`,
    id,
    challenge,
    kind,
    name,
    role,
    new Date(Date.now() + CHALLENGE_MS).toISOString(),
  );
  return id;
}

const busy = () => fail("Lots of people are signing in right now. Try again in a minute.", 429);

async function takeChallenge(env: Env, id: string, kind: string) {
  const [[row]] = await env.db.transaction([
    [`select challenge, name, role from challenges where id = ? and kind = ? and expires_at > ?`, id, kind, now()],
    [`delete from challenges where id = ?`, id],
  ]);
  return row as { challenge: string; name: string | null; role: string | null } | undefined;
}

const responseOf = <T>(context: Context): T | null => {
  const response = context.body?.response;
  return response && typeof response === "object" && typeof (response as { id?: unknown }).id === "string"
    ? (response as T)
    : null;
};

export async function registerOptions(context: Context): Promise<Response> {
  const name = cleanName(context.body?.name);
  if (!name) return fail("Pick a name of 2 to 40 letters, numbers or spaces.");
  const admin = isAdmin(context, context.body?.adminToken);
  const [[taken], [recent]] = await context.db.transaction([
    [`select 1 as taken from users where name = ?`, name],
    [
      `select count(*) as day, coalesce(sum(created_at > ?), 0) as hour from users where created_at > ?`,
      new Date(Date.now() - HOUR_MS).toISOString(),
      new Date(Date.now() - DAY_MS).toISOString(),
    ],
  ]);
  if (taken || (!admin && reserved(context, name))) return fail("That name is taken. Try another.", 409);
  if (!admin && (Number(recent?.hour) >= SIGNUPS_PER_HOUR || Number(recent?.day) >= SIGNUPS_PER_DAY)) {
    return fail("Lots of new accounts right now. Try again later.", 429);
  }
  const rp = relyingParty(context);
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: name,
    userDisplayName: name,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  const ticket = await issueChallenge(context, "register", options.challenge, name, admin ? "author" : "reader");
  return ticket ? json({ ticket, options }) : busy();
}

export async function register(context: Context): Promise<Response> {
  const response = responseOf<RegistrationResponseJSON>(context);
  const pending = response && (await takeChallenge(context, text(context.body?.ticket), "register"));
  if (!response || !pending?.name) return fail("That took too long. Please try again.");
  const rp = relyingParty(context);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false,
  }).catch((error: unknown) => {
    console.error("register", error);
    return null;
  });
  if (!verification?.verified) return fail("That passkey didn't work. Please try again.", 403);

  const { credential } = verification.registrationInfo;
  const session = await newSession();
  const stamp = now();
  const statements: CarrierSqlStatement[] = [
    [`insert into users (name, role, created_at) values (?, ?, ?)`, pending.name, pending.role ?? "reader", stamp],
    [
      `insert into passkeys (id, user_id, public_key, counter, transports, created_at, used_at)
       values (?, last_insert_rowid(), ?, ?, ?, ?, ?)`,
      credential.id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      stamp,
      stamp,
    ],
    [
      `insert into sessions (token_hash, user_id, created_at, expires_at)
       select ?, user_id, ?, ? from passkeys where id = ?`,
      session.hash,
      stamp,
      expiry(),
      credential.id,
    ],
    [`select u.id, u.name, u.role from users u join passkeys p on p.user_id = u.id where p.id = ?`, credential.id],
  ];
  try {
    const results = await context.db.transaction(statements);
    const user = toUser(results[3][0] as UserRow);
    return json({ session: session.token, user, liked: [] });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return fail("That name was just taken. Try another.", 409);
    throw error;
  }
}

export async function signinOptions(context: Context): Promise<Response> {
  const rp = relyingParty(context);
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "preferred" });
  const ticket = await issueChallenge(context, "signin", options.challenge);
  return ticket ? json({ ticket, options }) : busy();
}

export async function signin(context: Context): Promise<Response> {
  const response = responseOf<AuthenticationResponseJSON>(context);
  const pending = response && (await takeChallenge(context, text(context.body?.ticket), "signin"));
  if (!response || !pending) return fail("That took too long. Please try again.");
  const passkey = await context.db.one<{ user_id: number; public_key: Uint8Array; counter: number; transports: string | null }>(
    `select user_id, public_key, counter, transports from passkeys where id = ?`,
    response.id,
  );
  if (!passkey) return fail("That passkey isn't one this site knows. Create an account instead.", 404);
  const rp = relyingParty(context);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    credential: {
      id: response.id,
      publicKey: new Uint8Array(passkey.public_key),
      counter: Number(passkey.counter),
      transports: JSON.parse(passkey.transports ?? "[]"),
    },
    requireUserVerification: false,
  }).catch((error: unknown) => {
    console.error("signin", error);
    return null;
  });
  if (!verification?.verified) return fail("That passkey didn't work. Please try again.", 403);

  const session = await newSession();
  const stamp = now();
  const [, , [user], liked] = await context.db.transaction([
    [`update passkeys set counter = ?, used_at = ? where id = ?`, verification.authenticationInfo.newCounter, stamp, response.id],
    [`insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)`, session.hash, passkey.user_id, stamp, expiry()],
    [`select id, name, role from users where id = ?`, passkey.user_id],
    [`select slug from user_likes where user_id = ?`, passkey.user_id],
  ]);
  return json({ session: session.token, user: toUser(user as UserRow), liked: liked.map((row) => String(row.slug)) });
}

export async function rename(context: Context): Promise<Response> {
  const user = await actingUser(context);
  if (user instanceof Response) return user;
  const name = cleanName(context.body?.name);
  if (!name) return fail("Pick a name of 2 to 40 letters, numbers or spaces.");
  if (user.role !== "author" && reserved(context, name)) return fail("That name is taken. Try another.", 409);
  try {
    await context.db.all(`update users set name = ? where id = ?`, name, user.id);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return fail("That name is taken. Try another.", 409);
    throw error;
  }
  return json({ user: { ...user, name } });
}

export async function me(context: Context): Promise<Response> {
  const user = await currentUser(context);
  if (!user) return fail("Signed out", 401);
  const liked = await context.db.all<{ slug: string }>(`select slug from user_likes where user_id = ?`, user.id);
  return json({ user, liked: liked.map((row) => row.slug) });
}

export async function signout(context: Context): Promise<Response> {
  const token = text(context.body?.session);
  if (token) await context.db.all(`delete from sessions where token_hash = ?`, await hash(token));
  return json({ ok: true });
}

// The site's author signs in like anyone, then proves it once with the admin token.
export async function claim(context: Context): Promise<Response> {
  const user = await currentUser(context);
  if (!user) return fail("Sign in first.", 401);
  if (!isAdmin(context, context.body?.adminToken)) return fail("That token is no longer good.", 403);
  await context.db.all(`update users set role = 'author' where id = ?`, user.id);
  return json({ user: { ...user, role: "author" } });
}
