# Manual integration checklist (real Discord server)

Run on a private test server with the **test app** and accounts:
**A** = author/creator · **B, C** = targets · **D** = non-target (ManageMessages when needed) · **E** = added later.

Items marked **⚠** cover behaviour the official docs do not settle. **They block the MVP until observed.**
Record the date and outcome next to each item. Use `LOG_LEVEL=debug` and `SEEN_DEBUG_PAYLOADS=1`.

## M8 gate record

**Result: PASS** on 2026-09-30, baseline commit `8136a65`.
- Every item 1–24, including 22b, was run on a real Discord test server and **confirmed passed by the project owner**.
- No M0–M7 regressions were reported, so there are no fix commits.
- The per-item observations weren't transcribed into this file. The `PASS†` marks below record the owner's confirmation, not an agent's observation.
- Automated re-verification on `8136a65`: `pnpm check` ✅ (20 files / 231 tests); `pnpm test:coverage` ✅ (statements 90.33 %, branches 80.34 %, functions 91.19 %, lines 94.01 %).

| # | Check | Result |
|---|---|---|
| 1 | Install via invite URL; "Track Seen" appears under Apps (after `pnpm register-commands -- --guild <id>`); bot connects with **no privileged intents** (no close code 4014). | PASS† |
| 2 | ⚠ Track a message mentioning B and C. Debug log shows `resolved.messages[id].mentions` populated **without Message Content**; targets = B, C. | PASS† |
| 3 | ⚠ Companion is posted as a **reply**; B and C get **no notification** from it; A gets **no reply ping**; user names render in the card. | PASS† |
| 4 | Message with no mentions → picker. Selecting a bot + A (author) → rejected with explanation. Selecting C → started. | PASS† |
| 5 | B presses 👀 → Confirmed instantly. Again → Undo offered. Undo → falls back. | PASS† |
| 6 | D presses 👀 → "not a tracked target"; card unchanged. | PASS† |
| 7 | C replies → "replied · <time>". C deletes the reply → fallback. C replies twice, deletes one → still Interacted. | PASS† |
| 8 | ⚠ C reacts → row shows **"reacted" with no time**. Removing all of C's reactions → fallback. | PASS† |
| 9 | ⚠ Within 2h, C types then posts → Likely. With dev override `SEEN_WEAK_WINDOW_MINUTES=2`: activity after the window adds nothing; a reply still → Interacted. | PASS† |
| 10 | D (manager) adds target E: E's channel activity before being added does **not** count; E's reply before being added **does**. | PASS† |
| 11 | ⚠ Public thread the bot never joined: TYPING_START and MESSAGE_CREATE arrive with `channel_id` = thread id; parent-channel activity is **not** counted. | PASS† |
| 12 | ⚠ Forum post starter message: tracking works; replies are detected. | PASS† |
| 13 | ⚠ Private thread without the bot → clear error; after adding the bot → works. | PASS† |
| 14 | ⚠ Restart: stop the bot; while down, C replies and B deletes an older reply; start again: 👀 works on the old card and the card reflects both changes. | PASS† |
| 15 | Delete the source → card frozen "Original message was deleted". Delete the companion → DB shows `status_deleted`. | PASS† |
| 16 | ⚠ Archive a thread with an active card and trigger a render → error code logged (expected 50083). Unarchive → card re-renders. | PASS† |
| 17 | Manage: C is denied; D edits targets and stops. | PASS† |
| 18 | Admin restricts "Track Seen" to a role in Integrations → users without the role can't use it. | PASS† |
| 19 | Rapid typing/posting by B and C → at most one card edit per debounce window; no 429 storm in logs. | PASS† |
| 20 | Dev overrides `SEEN_TRACKING_TTL_MINUTES=3`, `SEEN_RETENTION_MINUTES=5` → card freezes as expired, then rows purged. | PASS† |
| 21 | Kick the bot → that guild's rows are purged. | PASS† |
| 22 | ⚠ `pnpm probe:reply-missing -- --channel <id>` → prints the error shape and **"OK: classified as SourceMissing"**. If not, fix `mapCreateCompanionError` and add the shape as a fixture. | PASS† |
| 22b | ⚠ `pnpm probe:history -- --channel <id>` → **"OK: every probe message delivered exactly once"** (confirms `before` returns the immediately preceding messages). | PASS† |
| 23 | ⚠ Short outage (~30 s network disconnect): logs show `Resumed` and **no** gap scan / reply verification / reaction pass; a reply made during the outage appears (replayed). | PASS† |
| 24 | ⚠ Long outage (~20 min, beyond resume window → fresh READY): watermark does **not** advance while down; after reconnect a backward gap scan runs with `lowerExclusive` ≈ pre-outage watermark − 5 min and `upperExclusive` ≈ readyAt + 60 s; C's reply appears; B's deleted reply is removed. Also: delete card X's companion and card Y's source while offline → Y freezes "Original message was deleted"; Track Seen on X's source creates a fresh companion. | PASS† |

† Owner-confirmed on 2026-09-30 (see the M8 gate record above).

Covered by automated integration tests (not manual): crash between insert and companion post, orphan-card
self-heal, nonce retry, crash during gap recovery, reply verification beyond 200 rows.
