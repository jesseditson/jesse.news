# social carrier

Accounts, comments, likes and the newsletter for jesse.news, stored in the site's own database (`site.sql`, Pro plan), with replies, likes, boosts and followers from the fediverse (`site.activitypub`), replies, likes and reposts from Bluesky (`site.atproto`) and webmentions from other sites (`site.webmentions`) mixed in.

Accounts are passkeys: no password and no email. Liking or commenting while signed out first asks the browser for this site's passkey, with a note beside what was clicked (browsers show no text of the site's own in their prompt). If there isn't one, the visitor picks a name and makes one. Synced passkeys follow them to their other devices.

Every request is `/carriers/social?action=<name>`. A carrier can't see the request method, so writes are the actions sent with a JSON body (POST) and reads are the ones without.

| Read (GET) | |
| --- | --- |
| `thread&path=post/<slug>` | Site comments, fediverse and Bluesky replies and webmention replies, oldest first, two levels deep; likes from all four, counted together; fediverse boosts with Bluesky and webmention reposts; and `mentions`, the other pages that link to the post or bookmark it, newest first. |
| `counts&paths=a,b,…` | Comment, like and boost totals for up to 100 posts, Bluesky and webmentions included. |
| `account` | The fediverse handle, and followers counting confirmed email subscribers alongside fediverse followers. |
| `interact&handle=@you@server[&path=…]` | The URL on the visitor's own server that opens this post (or the site's account) to reply, boost or follow. |
| `status&token=…` | A newsletter subscription's status. |
| `confirm&code=…` / `unsubscribe&token=…` | The links in newsletter email; both redirect home. |

| Write (POST) | |
| --- | --- |
| `register-options` / `register` | `{ name, adminToken? }`, then `{ ticket, response }` with the browser's new passkey. Answers `{ session, user, liked }`. The admin token makes the account the author. |
| `rename` | `{ session, name }`. Comments show an account's current name. |
| `signin-options` / `signin` | `{}`, then `{ ticket, response }` with the browser's passkey assertion. Answers `{ session, user, liked }`. |
| `me` / `signout` | `{ session }`: the signed-in account and the posts it liked / ends that session. |
| `claim` | `{ session, adminToken }`: makes a signed-in account the author. |
| `comment` | `{ session, path, body, parentId? }`, posted under the account's name; 20 an hour per account. |
| `remove` | `{ session, id }`: an account's own comment, or, for the author, any comment with its replies. |
| `like` / `unlike` | `{ session, path }`: one like per account per post. Likes made here are counted but not named. |
| `subscribe` / `unsubscribe` | `{ address }` / `{ token }`. |

Names are 2 to 40 characters and unique regardless of case; the site's own name and its author's name are only for the author.

Nothing here proves a visitor is a person: a script can make passkeys as easily as a phone. Until the platform checks devices itself, the carrier caps what one can do, sized for a site with a few dozen visitors a day:

- 3 new accounts an hour and 10 a day across the site (the author excepted), and 10 sign-ins waiting at once.
- 60 changes an hour per account: likes, comments, renames and removals all count, so no one account can spend the site's hourly database writes.
- 10 comments an hour per account, and 30 across the site.
- 3 newsletter confirmation emails an hour and 10 a day.

They're constants at the top of `auth.ts`, `comments.ts` and `newsletter.ts`.

`session` is the token `register` or `signin` answered. A carrier can't read cookies, so the browser keeps it and sends it in the body; only its hash is stored, and it lasts 180 days from last use. Each WebAuthn challenge is stored between its options and the response that answers it, for five minutes, and used once.

Every 15 minutes (the `schedule` in `package.json`), the `scheduled` export:

- reads `/feed.xml` and emails new posts to confirmed subscribers, 20 a run to stay under the site's 100 emails an hour. The first run only records what's already published, and a post dated more than a week before it first appears in the feed is never sent.
- passes each post's changed like count to `site.activitypub.setLocalLikes`, so other fediverse servers add this site's likes to the post's like count the next time they fetch it. A count that fails to send is retried on the next run.

## Setup

On the **Site** object in the editor:

- **Admin token** — a long random string. Open `https://jesse.news/?comment_token=<token>` once, then sign in (or create an account): that account becomes the author, who can take the site's own names and remove any comment.
- **Email from** — the site address newsletter mail comes from.
- **Webmention blocklist** — domains whose webmentions are left out of threads and counts, subdomains included. The platform keeps every verified mention and moderates none, so this is the only filter.

Boosts only come from the fediverse and from reposts on other sites, since a boost reshares a post to the booster's followers and a visitor here has none; the "Reply, like or boost from your own account" form sends people to their own server to do it there. Email subscribers show in the site's own follower count, not in the ActivityPub followers collection, which only the platform writes.

Passkeys are tied to the host they're made on, so make them on the site's canonical domain.

The carrier depends on `@simplewebauthn/server`, installed from this directory's `package-lock.json` when it deploys. Run `npm install` at the site's root (its `postinstall` installs this directory too) before `npm run check`.

`archival run` gives carriers a local SQLite file for `site.sql`; the preview in the Archival app has no database, so comments and likes only load on the deployed site and locally. Passkeys work under `archival run` on `localhost`. Only the deployed site runs the schedule.

Webmentions are received and sent by the platform, configured by the `[webmention]` section of `archival_editor.toml`: every post sends a mention to each page its content links to, and a link post sends a bookmark of its `link.url`, from a page Archival serves on `jesse.news` with the Site as author, and every page advertises the endpoint in a `Link` header. A reply that arrives both over ActivityPub and as a webmention is shown once. `archival run` (0.26.2 or later) and previews read as a site no mention has reached; earlier CLIs have no `site.webmentions`, which reads the same way here.

The site's Bluesky account is the platform's, configured by the `[atproto]` section of `archival_editor.toml`: posts are published as `@jesse.news`, and the likes, reposts and replies they get are read from Jetstream and handed to the carrier as `site.atproto`. A Bluesky reply is plain text and answered on bsky.app. An `archival run` without `site.atproto` (0.27.1 and earlier) reads as a site Bluesky hasn't touched.
