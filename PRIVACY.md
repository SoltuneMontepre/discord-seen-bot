# Privacy Policy — Seen (Discord acknowledgement bot)

_Last updated: 2026-09-29_

Seen helps a small team see whether people have acknowledged a Discord message. This page
explains, in plain language, what it collects and why.

## What Seen can and cannot know

Discord does not give bots read receipts. Seen **never knows whether you read a message**. It shows:

- **✅ Confirmed** — you pressed "👀 I've seen this".
- **💬 Interacted** — you replied to, or reacted on, the exact tracked message.
- **👁 Likely seen** — you typed or posted in the same channel within 2 hours after tracking started.
- **○ No signal** — none of the above.

Only ✅ is an explicit acknowledgement. The other states are inferred and can be wrong.

## What is collected

Only while a message is being tracked, and only about the people it targets (the people
mentioned in the message, or chosen by whoever started tracking):

- Discord IDs: server, channel, message, and user IDs.
- The first time a targeted person typed or posted in that channel within the 2-hour window.
- The IDs of replies a targeted person made to the tracked message (so a deleted reply can be removed).
- Which emoji a targeted person reacted with on the tracked message (no reaction time — Discord doesn't provide one).
- When a targeted person pressed "I've seen this", and whether they later undid it.

## What is never collected

- Message content — not even the tracked message's text (the bot has no Message Content access).
- Online/idle status, games, voice activity, or member lists.
- Activity of anyone who is not a target, or activity in other channels.
- Counts, frequencies, per-person histories, dashboards, or analytics.

## Retention

- Tracking ends automatically 7 days after it starts, or earlier when stopped, or when the
  message or its status card is deleted.
- All data for a tracked message is permanently deleted 30 days after tracking ends.
- If the bot is removed from a server, that server's data is deleted immediately.

## Your choices

- If you're a target, you can undo your own acknowledgement.
- Whoever started tracking, or a moderator, can remove you as a target — this deletes your data
  for that message.
- To have all of your data deleted, contact the bot operator; they run `pnpm forget-user <your id>`.

## Security

Data is stored in a SQLite database on storage that is encrypted at rest. Identity always
comes from Discord's own interaction and event payloads.

## Contact

Contact the operator of this bot in your Discord server.
