# Seen — lightweight acknowledgement tracking for Discord

A guild-installed Discord bot for a small team. Right-click a message → **Apps → Track Seen**, and
the bot posts a status card (as a reply) showing who acknowledged it:

```
👀 Seen status · 1/3 confirmed
✅ Confirmed     @Binh · 22:40
💬 Interacted    @An · replied · 22:41
                 @Kim · reacted
👁 Likely seen   @Huy · typing in channel · 22:42
○  No signal     @Linh
Only ✅ is an explicit acknowledgement. Other states are inferred from activity.
[👀 I've seen this] [Manage]
```

Discord gives bots **no read receipts**, so the bot separates what it *knows* from what it *infers*:

| State | Meaning |
|---|---|
| ✅ Confirmed | The person pressed "👀 I've seen this". The only explicit acknowledgement. |
| 💬 Interacted | Replied to, or reacted on, the exact tracked message (any time while tracked). |
| 👁 Likely seen | Typed or posted in the same channel within **2 hours after tracking started** (and after they became a target). |
| ○ No signal | None of the above. |

By default it uses **no privileged intents** — no Message Content, no member list, no presence.
The optional role-based auto-tracking ([below](#auto-tracking-optional)) adds exactly one: Server Members.
Message Content and Presence are never requested.

## Stack

TypeScript on Node 24 (native type stripping, no build step) · `@discordjs/core` + `@discordjs/ws` +
`@discordjs/rest` (cacheless, raw payloads) · SQLite via `better-sqlite3` + Kysely · Vitest · Biome · pnpm.

## Discord application setup

Use a separate **test app** for development.

1. [Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → reset token → put it in `.env`.
2. Bot settings: **Public Bot: OFF**. **All three Privileged Gateway Intents: OFF** — except
   **Server Members Intent: ON** if you set `ROLE_TARGETS_ENABLED=true` (Presence and Message Content stay OFF).
3. Installation: install context **Guild Install only**; scopes `bot applications.commands`; permissions **274877975552**
   (View Channel, Send Messages, Send Messages in Threads, Read Message History).
4. Invite: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=274877975552&integration_type=0`
5. Leave **Interactions Endpoint URL** empty (interactions arrive over the gateway).
6. Set the **Privacy Policy URL** to this repo's [`PRIVACY.md`](PRIVACY.md).
7. Register the commands ("Track Seen" and `/autotrack`):
   ```bash
   pnpm register-commands -- --guild <TEST_GUILD_ID>   # dev: instant
   pnpm register-commands -- --global                  # production
   ```

Gateway intents used: `GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | GUILD_MESSAGE_TYPING` = 3585,
plus `GUILD_MEMBERS` (= 3587) only when `ROLE_TARGETS_ENABLED=true`.

## Auto-tracking (optional)

Two independent flags, **both off by default** (off/off behaves exactly like manual-only Seen):

| `MENTION_AUTO_TRACK_ENABLED` | `ROLE_TARGETS_ENABLED` | Intents | Auto cards are created from | `/autotrack` |
|---|---|---|---|---|
| false | false | 3585 | nothing (manual Track Seen only) | "disabled" reply |
| true | false | 3585 | explicit `@user` mentions | "disabled" reply |
| false | true | 3587 | channel role policies | available |
| true | true | 3587 | `@user` mentions, `@role` mentions, channel role policies | available |

`AUTO_TRACK_MAX_TARGETS` (default 100, allowed 1–500) caps the eligible members of one auto card.

**Triggers.** Only a live, top-level (not a reply) message from a human, in a text or announcement
channel or a thread/forum post, can start an auto card; history scanned after downtime never does.
- **Mentions:** explicit `@user` (and, with roles on, `@role`) mentions in the message itself.
  `@everyone`/`@here` are never used. For forwarded messages only the forwarder's own mentions count;
  a mention that also appears in the forwarded snapshot is ignored.
- **Channel policies:** `/autotrack create channel name role` makes every plain message in that exact
  text/announcement channel an auto card for the role's members. Policies never apply to threads.
- One message gets one card; targets are the **union** of all its sources, without the author or bots.
  Nobody is pinged: cards and replies are sent with `allowed_mentions: { parse: [] }`.

**Fixed vs dynamic sources.** Mentioned users and roles are frozen when the message is posted;
editing the message later changes nothing. Role membership and channel policies are dynamic: a member
who gains a qualifying role becomes a target (with a fresh start time; an earlier acknowledgement is
never restored), and one who loses it — or leaves the server — is removed together with their
evidence, unless another source (e.g. an explicit mention) still qualifies them. An explicitly
mentioned user stays a target even after leaving the server. Auto cards show **Auto-tracked**; their
Manage panel offers **Stop** only.

**Acknowledgement.** Only a *current* target can press "👀 I've seen this" — the check happens in
the same database transaction as the write, on every click, for manual and auto cards alike.

**Stops.** An auto card ends when no eligible target remains ("no eligible targets remain"; its rows
are deleted), when it would exceed the limit ("too many eligible members"; last rows kept), or at
startup with `ROLE_TARGETS_ENABLED=false` for cards that depended on roles ("role-based auto-track was
turned off"; rows kept). Explicit-only cards keep running when roles are turned off.

**Policies.** `/autotrack create` and `/autotrack list [channel] [page]` (any server member; restrict
it under Server Settings → Integrations). The panel edits roles (up to 25 per policy), renames,
disables/enables and deletes. A policy whose last role is deleted becomes *disabled — its last role
was deleted* until a role is added again or "Keep disabled" is chosen. Deleting the channel deletes its
policies; removing the bot deletes the server's policies.

**Member state and the temporary pause.** With roles on, the bot keeps an in-memory map of members
of the roles it needs (never persisted), rebuilt from the member list on every `GUILD_CREATE` after
a fresh gateway session (not after a resume). Until that rebuild succeeds — and whenever it fails
(retries after 1, 5, 15 minutes, then every 15) — role-based work is **paused**: no role-based card is
created or changed, target-increasing policy changes are refused, and role-dependent cards show
*"⏸ Auto-track temporarily paused"* if the pause lasts over 60 s. Acknowledgements, evidence, Stop and
expiry keep working, and explicit-only cards are unaffected. This member-state recovery is separate
from the message watermark below. If the Server Members intent is not enabled in the Portal, Discord
closes the connection with 4014 and the bot exits with that explanation.

**Rollout.** Deploy with both flags off first (migration + command registration), optionally enable
mentions, then enable Server Members in the Portal and set `ROLE_TARGETS_ENABLED=true`, and run the
M9 section of the manual checklist. The M9 work was gated on the M0–M7 (M8) live checklist passing.

## Local development

```bash
pnpm install
cp .env.example .env        # fill DISCORD_TOKEN and DISCORD_APPLICATION_ID
pnpm dev                    # node --watch --env-file=.env src/main.ts
```

Dev-only overrides (ignored when `NODE_ENV=production`) shorten policy windows for manual testing:
`SEEN_WEAK_WINDOW_MINUTES`, `SEEN_TRACKING_TTL_MINUTES`, `SEEN_RETENTION_MINUTES`.
`SEEN_DEBUG_PAYLOADS=1` logs the **ids** of mentions in Track Seen payloads (never content).

## Verification

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm test             # vitest run
pnpm test:coverage
pnpm check            # typecheck && lint && test
```

Before the MVP is considered complete, run the real-server checklist in
[`docs/manual-checklist.md`](docs/manual-checklist.md). Items marked ⚠ cover behaviour the
official docs do not settle, including two dev-only probes:

```bash
pnpm probe:reply-missing -- --channel <TEST_CHANNEL_ID>
pnpm probe:history -- --channel <TEST_CHANNEL_ID>
```

## Deployment

**Prerequisite — encryption at rest (Discord Developer Terms §5c).** The database directory must
live on host storage that is encrypted at rest: a LUKS/dm-crypt disk, a provider-encrypted block
volume, or an encrypted filesystem. **A Docker/Podman named volume is not encrypted by itself** —
use a bind mount onto encrypted storage. Backups (e.g. Litestream to S3) must also go to storage
encrypted at rest.

```bash
docker build -t discord-seen-bot .
# /srv/seen-bot/data MUST be on encrypted storage
docker run -d --restart unless-stopped --env-file .env \
  -e DATABASE_PATH=/data/seen.db -v /srv/seen-bot/data:/data discord-seen-bot
```

Single instance only (SQLite, single writer). Migrations run on startup (`pnpm db:migrate` to run them
explicitly). `SIGTERM` shuts down gracefully (flushes pending card edits, stops accepting interactions).

## Operations

- **Deletion requests:** `pnpm forget-user -- <USER_ID>` deletes the user's targets, evidence,
  acknowledgements and auto-track mention sources everywhere, anonymizes references (including policy
  authors), stops active auto cards on the user's own messages (the author could otherwise no longer
  be excluded as a target), and re-renders affected cards.
- **Retention:** tracking expires after 7 days; all rows for a tracked message are deleted 30 days
  after tracking stops; removing the bot from a server purges that server immediately.

## How it works

```
gateway (ws) ──► adapters (pure: payload → Signal, ids only)
                   │
                   ▼
            TrackingService.recordSignal ──► SQLite (evidence only for targets, validity at write)
                   │                               │
                   ▼                               ▼
            RenderScheduler (debounce 3 s / max 10 s, hash diff) ──► PATCH status card
interactions ──► router (stateless, custom_id `sb1:<action>:<id>`) ──► service / scheduler
Reconciler: backward `before` pagination for gaps (bounded by a gateway-health watermark),
            reaction pass (also detects sources deleted while offline), exhaustive reply verification.
```

- Evidence and state are separate: the 4-state view is a pure projection (`src/domain/projection.ts`)
  of targets + evidence + acknowledgements.
- Buttons survive restarts: all state is in SQLite and ids are never reused.
- The recovery watermark `last_gateway_healthy_at` advances only while the gateway is connected,
  heartbeats are acknowledged, and no gap recovery is pending. It covers message-derived evidence;
  typing is best-effort and can be lost during outages.

## Known limitations (by design / Discord platform)

- Nobody can know whether a message was *read*; only ✅ is explicit.
- Typing during downtime cannot be recovered.
- Reaction times are unknown (Discord provides none), so reactions show no time.
- Without the privileged member intent (the default), a user leaving the server isn't observed; they keep their last state.
- `@everyone`/`@here` are never expanded into targets. `@role` mentions are expanded only by auto-tracking with
  `ROLE_TARGETS_ENABLED=true`; manual Track Seen targets only explicitly mentioned or picked users.
- The initial backfill of pre-existing replies scans at most 1,000 messages before the tracking-start
  snapshot; for an old message in a busy channel, replies closest to the source may be missed.
- DMs, group DMs and user-installed apps are out of scope.
