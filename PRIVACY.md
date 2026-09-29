# Privacy Policy — Seen (Discord acknowledgement bot)

_Last updated: 2026-09-30_

Seen helps a small team see whether people have acknowledged a Discord message. This page
explains, in plain language, what it collects and why.

## What Seen can and cannot know

Discord does not give bots read receipts. Seen **never knows whether you read a message**. It shows:

- **✅ Confirmed** — you pressed "👀 I've seen this".
- **💬 Interacted** — you replied to, or reacted on, the exact tracked message.
- **👁 Likely seen** — you typed or posted in the same channel within 2 hours after tracking started.
- **○ No signal** — none of the above.

Only ✅ is an explicit acknowledgement. The other states are inferred and can be wrong.

## Automatic tracking (only if the operator enables it)

The operator can turn on two optional features:

- **Mention auto-track** — when enabled, **mentioning someone can automatically create a status
  card** for your message, targeting the people you mentioned (never `@everyone`/`@here`).
- **Role-based auto-track** — status cards can target the members of a role, either because a role
  was mentioned or because a channel has an auto-track policy. **Any member of the server can create
  or change these policies** with `/autotrack` (admins can restrict the command under Integrations).
  This feature uses Discord's **Server Members** access so the bot knows who currently has which role.

Nobody is pinged by these cards. Editing a message later does not change who is tracked.

## What is collected

Only while a message is being tracked, and only about the people it targets (the people
mentioned in the message, members of a targeted role, or people chosen by whoever started tracking):

- Discord IDs: server, channel, message, and user IDs.
- The first time a targeted person typed or posted in that channel within the 2-hour window.
- The IDs of replies a targeted person made to the tracked message (so a deleted reply can be removed).
- Which emoji a targeted person reacted with on the tracked message (no reaction time — Discord doesn't provide one).
- When a targeted person pressed "I've seen this", and whether they later undid it.
- For automatically tracked messages: the IDs of the users and roles mentioned in the message
  (kept with the tracking, under the same retention).
- Auto-track policies: channel ID, policy name, role IDs, state, and the IDs of who created or last
  changed them (kept until the policy is deleted).

**In memory only, never stored:** with role-based auto-track, the bot keeps a temporary map of which
members hold the roles it currently needs. It is rebuilt from Discord after restarts and never written
to disk; it is not a member directory and keeps no history.

## What is never collected

- Message content — not even the tracked message's text (the bot has no Message Content access).
- Online/idle status, games, voice activity, or a stored member list.
- The contents or mentions of forwarded messages (only the forwarder's own mentions are used).
- Activity of anyone who is not a target, or activity in other channels.
- Counts, frequencies, per-person histories, dashboards, or analytics.

## Retention

- Tracking ends automatically 7 days after it starts, or earlier when stopped, or when the
  message or its status card is deleted.
- All data for a tracked message is permanently deleted 30 days after tracking ends.
- If the bot is removed from a server, that server's data (including its policies) is deleted immediately.
- Deleting a channel deletes its auto-track policies. If a role is deleted, it is removed from policies
  and tracked messages.
- If you stop qualifying for an auto-tracked message (for example you lose the role), your data for
  that message is deleted — immediately, or as soon as the bot's member information is available
  again after an outage.

## Your choices

- If you're a target, you can undo your own acknowledgement.
- Whoever started tracking, or a moderator, can remove you as a target — this deletes your data
  for that message.
- To have all of your data deleted, contact the bot operator; they run `pnpm forget-user <your id>`.
  This also removes you from auto-tracking mention records, replaces your ID on any policy you
  created or changed, and ends automatic tracking of your own messages. If you still hold a role an
  active card targets, you can be added again as a current target later.

## Security

Data is stored in a SQLite database on storage that is encrypted at rest. Identity always
comes from Discord's own interaction and event payloads.

## Contact

Contact the operator of this bot in your Discord server.
