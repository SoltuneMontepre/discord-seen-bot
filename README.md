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

It uses **no privileged intents** — no Message Content, no member list, no presence.

## Stack

TypeScript on Node 24 (native type stripping, no build step) · `@discordjs/core` + `@discordjs/ws` +
`@discordjs/rest` (cacheless, raw payloads) · SQLite via `better-sqlite3` + Kysely · Vitest · Biome · pnpm.

## Discord application setup

Use a separate **test app** for development.

1. [Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → reset token → put it in `.env`.
2. Bot settings: **Public Bot: OFF**. **All three Privileged Gateway Intents: OFF.**
3. Installation: install context **Guild Install only**; scopes `bot applications.commands`; permissions **274877975552**
   (View Channel, Send Messages, Send Messages in Threads, Read Message History).
4. Invite: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=274877975552&integration_type=0`
5. Leave **Interactions Endpoint URL** empty (interactions arrive over the gateway).
6. Set the **Privacy Policy URL** to this repo's [`PRIVACY.md`](PRIVACY.md).
7. Register the command:
   ```bash
   pnpm register-commands -- --guild <TEST_GUILD_ID>   # dev: instant
   pnpm register-commands -- --global                  # production
   ```

Gateway intents used: `GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | GUILD_MESSAGE_TYPING` = 3585.

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

- **Deletion requests:** `pnpm forget-user -- <USER_ID>` deletes the user's targets, evidence and
  acknowledgements everywhere, anonymizes references, and re-renders affected active cards.
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
- Without the privileged member intent, a user leaving the server isn't observed; they keep their last state.
- Role/@everyone mentions are not expanded into targets (would need the member list).
- The initial backfill of pre-existing replies scans at most 1,000 messages before the tracking-start
  snapshot; for an old message in a busy channel, replies closest to the source may be missed.
- DMs, group DMs and user-installed apps are out of scope.
