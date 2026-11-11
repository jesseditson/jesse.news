import type { Carrier, CarrierScheduled } from "@archival/carrier";
import * as auth from "./auth";
import { like, syncLikes, unlike } from "./likes";
import * as comments from "./comments";
import { Database } from "./db";
import { account, interact } from "./fediverse";
import { type Context, fail, fields } from "./http";
import * as newsletter from "./newsletter";

type Handler = (context: Context) => Promise<Response | string>;

// A carrier never sees the request's method, only whether it carried a body, so writes are told apart by that.
const READS: Record<string, Handler> = {
  thread: comments.thread,
  counts: comments.counts,
  status: newsletter.status,
  confirm: newsletter.confirm,
  unsubscribe: newsletter.unsubscribe,
  interact,
  account: async (context) => account(context, await newsletter.subscriberCount(context)),
};

const WRITES: Record<string, Handler> = {
  "register-options": auth.registerOptions,
  register: auth.register,
  "signin-options": auth.signinOptions,
  signin: auth.signin,
  me: auth.me,
  signout: auth.signout,
  claim: auth.claim,
  rename: auth.rename,
  comment: comments.create,
  remove: comments.remove,
  like,
  unlike,
  subscribe: newsletter.subscribe,
  unsubscribe: newsletter.unsubscribe,
};

const carrier: Carrier = async (params, body, objects, site) => {
  const action = params.get("action") ?? "";
  const data = fields(body);
  const routes = data ? WRITES : READS;
  if (!Object.hasOwn(routes, action)) return fail("not found", 404);

  const db = new Database(site.sql);
  try {
    await db.migrate();
    return await routes[action]({ params, body: data, objects, site, db });
  } catch (error) {
    console.error(action, error);
    return fail("Something went wrong. Try again in a bit.", 500);
  }
};

export default carrier;

// On the schedule in package.json.
export const scheduled: CarrierScheduled = async (objects, site) => {
  const db = new Database(site.sql);
  await db.migrate();
  const env = { objects, site, db };
  const [delivery, synced] = await Promise.allSettled([newsletter.deliver(env), syncLikes(env)]);
  if (delivery.status === "fulfilled") {
    const { sent, failed, waiting } = delivery.value;
    if (sent || failed || waiting) console.log(`newsletter: sent ${sent}, failed ${failed}, waiting ${waiting}`);
  }
  if (synced.status === "fulfilled" && synced.value) console.log(`likes: synced ${synced.value} posts`);
  const failures = [delivery, synced].filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "scheduled run failed");
};
