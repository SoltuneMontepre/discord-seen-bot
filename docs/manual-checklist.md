# Manual integration checklist (real Discord server)

Run on a private test server with the **test app** and accounts:
**A** = author/creator · **B, C** = targets · **D** = non-target (ManageMessages when needed) · **E** = added later.

Items marked **⚠** cover behaviour the official docs do not settle. **They block the MVP until observed.**
Record the date and outcome next to each item. Use `LOG_LEVEL=debug` and `SEEN_DEBUG_PAYLOADS=1`.

| # | Check | Result |
|---|---|---|
| 1 | Install via invite URL; "Track Seen" appears under Apps (after `pnpm register-commands -- --guild <id>`); bot connects with **no privileged intents** (no close code 4014). | |
| 2 | ⚠ Track a message mentioning B and C. Debug log shows `resolved.messages[id].mentions` populated **without Message Content**; targets = B, C. | |
| 3 | ⚠ Companion is posted as a **reply**; B and C get **no notification** from it; A gets **no reply ping**; user names render in the card. | |
| 4 | Message with no mentions → picker. Selecting a bot + A (author) → rejected with explanation. Selecting C → started. | |
| 5 | B presses 👀 → Confirmed instantly. Again → Undo offered. Undo → falls back. | |
| 6 | D presses 👀 → "not a tracked target"; card unchanged. | |
| 7 | C replies → "replied · <time>". C deletes the reply → fallback. C replies twice, deletes one → still Interacted. | |
| 8 | ⚠ C reacts → row shows **"reacted" with no time**. Removing all of C's reactions → fallback. | |
| 9 | ⚠ Within 2h, C types then posts → Likely. With dev override `SEEN_WEAK_WINDOW_MINUTES=2`: activity after the window adds nothing; a reply still → Interacted. | |
| 10 | D (manager) adds target E: E's channel activity before being added does **not** count; E's reply before being added **does**. | |
| 11 | ⚠ Public thread the bot never joined: TYPING_START and MESSAGE_CREATE arrive with `channel_id` = thread id; parent-channel activity is **not** counted. | |
| 12 | ⚠ Forum post starter message: tracking works; replies are detected. | |
| 13 | ⚠ Private thread without the bot → clear error; after adding the bot → works. | |
| 14 | ⚠ Restart: stop the bot; while down, C replies and B deletes an older reply; start again: 👀 works on the old card and the card reflects both changes. | |
| 15 | Delete the source → card frozen "Original message was deleted". Delete the companion → DB shows `status_deleted`. | |
| 16 | ⚠ Archive a thread with an active card and trigger a render → error code logged (expected 50083). Unarchive → card re-renders. | |
| 17 | Manage: C is denied; D edits targets and stops. | |
| 18 | Admin restricts "Track Seen" to a role in Integrations → users without the role can't use it. | |
| 19 | Rapid typing/posting by B and C → at most one card edit per debounce window; no 429 storm in logs. | |
| 20 | Dev overrides `SEEN_TRACKING_TTL_MINUTES=3`, `SEEN_RETENTION_MINUTES=5` → card freezes as expired, then rows purged. | |
| 21 | Kick the bot → that guild's rows are purged. | |
| 22 | ⚠ `pnpm probe:reply-missing -- --channel <id>` → prints the error shape and **"OK: classified as SourceMissing"**. If not, fix `mapCreateCompanionError` and add the shape as a fixture. | |
| 22b | ⚠ `pnpm probe:history -- --channel <id>` → **"OK: every probe message delivered exactly once"** (confirms `before` returns the immediately preceding messages). | |
| 23 | ⚠ Short outage (~30 s network disconnect): logs show `Resumed` and **no** gap scan / reply verification / reaction pass; a reply made during the outage appears (replayed). | |
| 24 | ⚠ Long outage (~20 min, beyond resume window → fresh READY): watermark does **not** advance while down; after reconnect a backward gap scan runs with `lowerExclusive` ≈ pre-outage watermark − 5 min and `upperExclusive` ≈ readyAt + 60 s; C's reply appears; B's deleted reply is removed. Also: delete card X's companion and card Y's source while offline → Y freezes "Original message was deleted"; Track Seen on X's source creates a fresh companion. | |

Covered by automated integration tests (not manual): crash between insert and companion post, orphan-card
self-heal, nonce retry, crash during gap recovery, reply verification beyond 200 rows.
