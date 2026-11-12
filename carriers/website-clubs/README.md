# website-clubs carrier

A public, subscribable iCalendar feed of website meetups (Homebrew Website Clubs, IndieWeb meetups and the like), merged from several source feeds.

- `https://jesse.news/carriers/website-clubs`: the merged calendar (`text/calendar`). Subscribe with that URL, or `webcal://jesse.news/carriers/website-clubs`.
- `https://jesse.news/carriers/website-clubs?format=json`: the same events as JSON, plus each source feed's event count, last fetch and last error.

It's `"access": "public"` so calendar apps can poll it without the browser proof.

## Sources

The feeds, and the calendar's name and description, come from the `website_clubs` object (`objects/website_clubs.toml`), so they're edited in the Archival editor under **website_clubs**. Feeds are merged in the order they're listed there: when two feeds list the same meetup, the copy from the one listed first is kept. Each feed is a `name` (shown as the event's source; blank falls back to the feed's hostname) and an `http(s)` `url`.

## How it merges

- Every hour (the `schedule` in `package.json`) `scheduled` fetches each feed and stores a copy in `site.sql` (`website_clubs_feeds`, keyed by URL), and drops stored copies of feeds no longer in the object. A copy keeps only the events that haven't ended more than 30 days ago and the time zones they use, so a feed carrying years of history (events.indieweb.org is over 2 MB) still fits in one row. Feeds up to 10 MB are read. A request serves from those copies, fetching any that are missing or older than 6 hours.
- Only a complete calendar (starts `BEGIN:VCALENDAR`, ends `END:VCALENDAR`) replaces a stored copy. A feed that fails, times out or comes back truncated keeps serving its last good copy, so one source going down doesn't drop its events from subscribers' calendars.
- Events are passed through as the source wrote them (UID, SEQUENCE, STATUS, TZID), with `VALARM`s removed and an `X-WEBSITE-CLUBS-SOURCE` property added. Cancelled events stay in with `STATUS:CANCELLED`, so subscribed clients mark or remove them themselves. `VTIMEZONE`s are carried over once per TZID, and only when an event uses them.
- Duplicates across feeds are dropped in favour of the earlier feed: the same UID, the same event URL, or the same normalized title starting within 15 minutes.
- Events that ended more than 30 days ago are dropped. Recurring events (`RRULE`) are not expanded; none of the current sources use them.

Without a database (the app preview, `archival run`) every request fetches the feeds live. Only the deployed site runs the schedule.
