# website-clubs carrier

A public, subscribable iCalendar feed of website meetups (Homebrew Website Clubs, IndieWeb meetups and the like), merged from several source feeds.

- `https://jesse.news/carriers/website-clubs`: the merged calendar (`text/calendar`). Subscribe with that URL, or `webcal://jesse.news/carriers/website-clubs`.
- `https://jesse.news/carriers/website-clubs?format=json`: the same events as JSON, plus each source feed's event count, last fetch and last error.

It's `"access": "public"` so calendar apps can poll it without the browser proof.

## Sources

`FEEDS` at the top of `index.ts`, in priority order:

1. `https://events.indieweb.org/ics/events`
2. Iffy Books Homebrew Website Club, Philadelphia (`iffybooks.net`, The Events Calendar series export); not listed on events.indieweb.org.

Add a feed by adding an entry there.

## How it merges

- Every hour (the `schedule` in `package.json`) `scheduled` fetches each feed and stores the raw body in `site.sql` (`website_clubs_feeds`). A request serves from those copies, fetching any that are missing or older than 6 hours.
- Only a complete calendar (starts `BEGIN:VCALENDAR`, ends `END:VCALENDAR`) replaces a stored copy. A feed that fails, times out or comes back truncated keeps serving its last good copy, so one source going down doesn't drop its events from subscribers' calendars.
- Events are passed through as the source wrote them (UID, SEQUENCE, STATUS, TZID), with `VALARM`s removed and an `X-WEBSITE-CLUBS-SOURCE` property added. Cancelled events stay in with `STATUS:CANCELLED`, so subscribed clients mark or remove them themselves. `VTIMEZONE`s are carried over once per TZID, and only when an event uses them.
- Duplicates across feeds are dropped in favour of the earlier feed: the same UID, the same event URL, or the same normalized title starting within 15 minutes.
- Events that ended more than 30 days ago are dropped. Recurring events (`RRULE`) are not expanded; none of the current sources use them.

Without a database (the app preview, `archival run`) every request fetches the feeds live. Only the deployed site runs the schedule.
