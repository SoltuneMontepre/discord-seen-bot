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

---

# M9 — auto-tracking (mentions + channel role policies)

**Status: NOT RUN.** Nothing below has been observed on Discord yet. Automated tests cover the logic
with fakes; every row stays unverified until a human records a result here. Items marked **⚠** check
payload details the official docs do not settle.

## Human setup

1. **Mention-only items (flags `M only`):** in `.env` set `MENTION_AUTO_TRACK_ENABLED=true`,
   `ROLE_TARGETS_ENABLED=false`. **Do not** enable Server Members Intent for these.
2. **Role / policy items:** Developer Portal → test app → **Bot** → Privileged Gateway Intents:
   **Server Members Intent: ON**, **Presence Intent: OFF**, **Message Content Intent: OFF**. Then set
   `ROLE_TARGETS_ENABLED=true` (and `MENTION_AUTO_TRACK_ENABLED=true` for `M+R` items).
3. **Test server:** create roles `@Dev`, `@QA`, `@Security`; accounts A–E as below; a text channel
   **#important** (with policies), an unconfigured **#general**, a public thread under #important,
   and a forum channel. Assign/remove roles via Server Settings → Members during the checklist.
   Administrator is **not** required for the bot; keep the invite permissions `274877975552`.
4. Re-register commands: `pnpm register-commands -- --guild <TEST_GUILD_ID>`; confirm both
   **Track Seen** and **/autotrack** appear.
5. Restart the bot (`pnpm dev`, or restart the container) after every flag change.
6. Use `LOG_LEVEL=debug`. For ⚠ items record the observed payload shape next to the result.

**Preconditions:** the M8 baseline has passed (see *M8 gate record*). Limit `AUTO_TRACK_MAX_TARGETS=100`
unless an item says otherwise.

| Account | Roles |
|---|---|
| A | author, `@Dev` |
| B | `@Dev` |
| C | `@QA` |
| D | `@Dev` + `@QA` |
| E | none |

Flags: `M+R` = both on · `M only` = mentions on, roles off · `R only` = roles on, mentions off ·
`both off` = default.

## Policy flows (rev 3 items, both flags on)

| # | Flags | Check | Result |
|---|---|---|---|
| M9-1 | M+R | `/autotrack create` "Eng" (`@Dev`) and "QA" (`@QA`) on #important; `/autotrack list` shows both, with counts. | |
| M9-2 | M+R | Plain message from A (no mention): **one** card with "Auto-tracked"; targets B, C, D (A excluded, D once); nobody pinged. | |
| M9-3 | M+R | Give E `@Dev` → E appears. Remove `@Dev` from B → B disappears **and B's earlier ack disappears**. | |
| M9-4 | M+R | Remove `@QA` from D → D stays (via `@Dev`). | |
| M9-5 | M+R | D2: C confirms and replies; remove C's `@QA` → C gone; give it back → C returns as INTERACTED "replied" (ack not restored). | |
| M9-6 | M+R | Add `@Security` to "Eng" → its members appear. Disable "QA" → C disappears. Delete "Eng" → only users qualifying via other enabled policies remain. | |
| M9-7 | M+R | Delete role `@QA` in Server Settings → its members disappear; "QA" shows "Disabled — its last role was deleted. Add a role to re-enable."; adding a role re-enables it. Repeat with "QA" first **user-disabled**: after the last role is deleted and a role is re-added, it stays disabled. Record whether per-member updates arrived (unverified). | |
| M9-8 | M+R | A change that leaves zero targets → card frozen "no eligible targets remain" with no rows; adding members does not revive it; a new message creates a new card. | |
| M9-9 | M+R | Replies, messages in a thread under #important, a forum post, bot/webhook messages → no card. A forward in #important → card (D10); record the forward's `type`. ¹ | |
| M9-10 | M+R | Set `AUTO_TRACK_MAX_TARGETS=2`: config adding a large role is rejected; a message with >2 eligible gets no card (log line); an active tracking that grows past 2 stops "too many eligible members" and **keeps its last rows**. Set 0 or 501 → startup fails. | |
| M9-11 | M+R | Stop the bot, change roles and delete a referenced role, start: an ack clicked immediately shows the pause notice (if before the rebuild completes); targets heal after `GUILD_CREATE`; the deleted role is pruned; routine restart causes no mass card edits. | |
| M9-12 | M+R | Short disconnect (~30 s): `Resumed`, no rebuild, no pause notice, member changes arrive via replay. | |
| M9-13 | M+R | Long disconnect (beyond the resume window): fresh session → `GUILD_CREATE` rebuild; missed changes heal. | |
| M9-14 | M+R | Temporary pause: on a dev machine, block outbound HTTPS to `discord.com/api` and trigger a rebuild (policy change adding a new role). Logs show "auto-track paused". After ~60 s, active auto cards show "Auto-track temporarily paused — … Last known targets are shown." They are **not** stopped, and acks and manual cards keep working. Unblock → logs show "resumed", the notice disappears, and targets are correct. ² | |
| M9-15 | M+R | Portal: Message Content off, Presence off, Server Members on. Flag true with the toggle off → startup fails with the explicit 4014 message. | |
| M9-16 | M+R → R off | Flag false with active auto cards: on restart they show "role-based auto-track was turned off" **with their last rows**; manual cards unchanged; intents 3585; `/autotrack` says disabled; manual Track Seen passes the M8 checks. ³ | |
| M9-17 | M+R | Manual Track Seen in #important on a message without an auto card: role changes, policy changes, and the pause notice don't affect it. | |
| M9-18 | M+R | ⚠ Verify `GUILD_MEMBER_UPDATE.roles` is the full list, and `user.bot` is present for bots. | |
| M9-19 | M+R | ⚠ Verify thread messages carry the thread id (no auto card in threads). ¹ | |
| M9-20 | M+R | An ordinary member with no permissions can create and edit policies; a policy id from another guild in a forged `custom_id` is refused. | |
| M9-21 | M+R | A role with >25 eligible members (≤ limit): the card shows 25 lines + "+N more" with correct counts. | |

¹ Rev 5 (E4/D4): a *plain* message in a thread or forum post creates no card, because policies
never apply to threads. A message **with mentions** there does create a card from its mentions
(see M9-31).
² Rev 5 (§9.3): only **role-dependent** auto cards show the notice; explicit-only and manual cards
never do.
³ Rev 5 (D6): explicit-only auto cards keep running when role targets are turned off.

## Mentions, pause, edits, forwards, authorization (rev 4/5 items)

| # | Flags | Check | Result |
|---|---|---|---|
| M9-22 | M+R | In #general, A sends "@B @E please review" → one "Auto-tracked" card, targets B and E, nobody pinged. | |
| M9-23 | M+R | "@QA please check" in #general → C and D. E gains `@QA` → appears. C loses `@QA` → removed. | |
| M9-24 | M+R | "@everyone" / "@here" → no card. | |
| M9-25 | M+R | A reply with "@B" → no card; bot or webhook message with mentions → no card. | |
| M9-26 | M+R | In #important (policy "QA"), "@B look" → one card: B, C, D; D appears once. | |
| M9-27 | M+R | "@D @Dev …"; D loses `@Dev` → D stays (explicit). | |
| M9-28 | M only | **Mentions on, roles off.** "@B" → card for B. "@Dev" only → **no card**. "@B @Dev" → card for **B only**. Intents 3585; `/autotrack` says disabled. | |
| M9-29 | M+R | **Paused** (block REST as in M9-14): "@B @E" (no policy in #general) → **card created, no pause notice**. "@B @Dev" → **no card**. In #important (has a policy), "@B" → **no card**. | |
| M9-30 | M+R | **Edit after tracking starts:** edit "@B check" → "@E check" → targets stay B; E is not added; B's ack stays. Editing an untracked message to add "@B" → no card. | |
| M9-31 | M+R | **Thread / forum:** "@B" in the public thread under #important → card with **B only**; the #important policy's roles are **not** added. A forum post starter with "@E" → card for E. A thread message with no mentions → no card. | |
| M9-32 | M+R | **Forward:** forward a message that contained "@Dev @C" into #general → **no** targets from the snapshot (no card, unless the forwarder adds their own outer mention). Record whether the outer `mentions` is empty or copied (§0.2 #10). In #important, the forward triggers via the policy with policy targets only. | |
| M9-33 | M+R | ⚠ Record: `mention_roles` for a non-mentionable role mentioned without permission; `channel_type` presence (text, thread, forum post); the forward's outer `type`, `message_reference.type` and `HAS_SNAPSHOT` flag. | |
| M9-34 | M+R | **Explicit target leaves:** in the M9-22 card, E leaves the guild → E **remains** a target. In an "@QA" card, C leaves → C removed. | |
| M9-35 | M+R | **Ack authorization after all of the above:** the author clicks their own auto card → rejected. A roles-off-ignored `@Dev` user (M9-28) → rejected. The edited-in E (M9-30) → rejected. Snapshot users (M9-32) → rejected. The thread target B (M9-31) → accepted. A parent-policy-only user in the thread → rejected. A dynamically added `@QA` member → accepted on the existing card. A removed member → rejected, not restored. | |
| M9-36 | R only | Mentions off, roles on: "@B" in #general → no card; a plain message in #important → policy card. | |
| M9-37 | both off | No auto cards at all; intents 3585; M8 behaviour. | |
| M9-38 | — | Manual Track Seen: current target confirms, non-target rejected, role/policy changes never alter it. | |
