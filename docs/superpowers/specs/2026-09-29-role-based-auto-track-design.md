# M9 — Auto-tracking (message mentions + channel role policies): design spec

**Status:** rev 5 — **final design**, awaiting the go-ahead for the implementation plan.

**Revision history:**
- **Rev 1** was reviewed on 2026-09-29.
- **Rev 2** folded in Q0 and D2–D16.
- **Rev 3** was approved: grace period 60 s, global edit concurrency 2, "Keep disabled".
- **Rev 4** added R11 (mention-triggered auto tracking) and R12 (current-target acknowledgement).
- **Rev 5** records the approved final decisions E1–E5 and the explicit-user-leaves semantic, and adds a whole-spec consistency pass (§21).

**Open decisions:** none.

**Date:** 2026-09-29. **Baseline:** commit `8136a65` (M0–M7). No product code has been written for M9.

## Dependency gate (Q0, approved, unchanged)

| M9 activity | Allowed when |
|---|---|
| Design/spec work (this document) | Now |
| Implementation plan | After this spec is approved |
| **Product implementation** | **Only after the M8 real-Discord baseline (`docs/manual-checklist.md`, M0–M7) has been run and any M0–M7 regressions it finds are fixed and committed** |

We need a known-good live baseline before introducing privileged intents, member-state recovery, policy reconciliation and automatic tracking. The implementation plan's first task is the gate itself: record the M8 checklist as passed, with the commit hash.

---

## 0. Investigation summary

### 0.1 What exists today (M0–M7) that M9 builds on

| Area | Current implementation | Relevance to M9 |
|---|---|---|
| Composition | `src/bot.ts` `createBot()` wires the repo, `RenderScheduler`, `TrackingService`, `GatewayHealth`, `Reconciler`, `Sweeper` and `InteractionRouter`. `src/main.ts` injects the real REST API and the ws manager. | New components plug in here. |
| Gateway | `attachGateway()`: ws lifecycle events go to `GatewayHealth`. `Dispatch` goes through pure adapters to `recordSignal()` or `router.handle()`. | Add member/role/guild dispatch and the auto-track candidate. |
| Intents | `src/discord/intents.ts`: `INTENTS = 3585`. `assertNoPrivilegedIntents` rejects all privileged bits. | Must become flag-aware and allow `GUILD_MEMBERS` only. |
| Supported source-message locations | `SUPPORTED_CHANNEL_TYPES` in `src/discord/permissions.ts`: GuildText, GuildAnnouncement, AnnouncementThread, PublicThread, PrivateThread. Forum and media posts are PublicThread. It is used by manual `validateChannel()`. | **Reused as the mention-trigger scope** (E4). |
| Tracking start | `startTracking()` / `checkExisting()`: insert → companion (`nonce`, `enforce_nonce`, `fail_if_not_exists: true`) → rollback on failure. | The auto path reuses these pieces, split into phase A (insert) and phase B (publish). |
| Manual targets | `track-seen.ts`: `mentions` → `eligibleTargets(…, 25)` or the picker. Static targets. Message types 0 and 19 are allowed. | Unchanged. R12 formalizes the acknowledgement rule. |
| Targets / evidence | `added_at` is the weak-evidence lower bound. `repo.replaceTargets()` does a transactional diff: removed users lose their evidence and acks, added users get `added_at = at`. | This is exactly the reconciler's DB semantics. |
| Acknowledgement | `repo.acknowledge()`: the target check and the write happen in **one transaction**. `handleAck` checks `message.id === status_message_id`, replies ephemerally to non-targets, and self-heals orphan cards. | Already satisfies most of R12 (§12.6). |
| Target backfill | `Reconciler.backfillTargets()`: `(source, max(addedAt) + 60 s)`, 10-page cap, then the reaction pass. | Governs D2. |
| Stop reasons | CHECK constraint in `0001_initial`. | New reasons need a table rebuild (§7.1). |
| Uniqueness | `ux_tracked_active_source` (active rows only). | Needs permanent uniqueness for auto trackings (§11). |
| Recovery | Message-evidence watermark, backward gap scan, reaction pass, reply verification. `Resumed` does no reconciliation. | **Unchanged.** Member state gets its own recovery concept (§9). |
| Rendering | `RenderScheduler`: debounce, per-tracking serialization, hash-diff. | Adds a global edit cap of 2 and pause-aware views. |
| Channel metadata | The bot is cacheless and keeps **no** channel cache. | No cached channel lookup exists for E4, so a missing `channel_type` fails closed. |
| Message edits | `MESSAGE_UPDATE` is not consumed today. | E1: it stays unconsumed for sources and targets. |
| Migrations | The Kysely migrator runs all pending SQLite migrations in one transaction, where `PRAGMA foreign_keys` has no effect. | Governs the rebuild technique. |
| Startup | migrate → `deleteUnfinishedStarts` → sweep → create gateway → connect. | The D6 stop sweep slots in before the gateway is created. |
| Tests | 231 tests plus fakes. | Extend; nothing removed. |

### 0.2 Discord facts verified against current official docs

Sources: docs.discord.com and discord-api-docs `main`, rechecked 2026-09-29.

**Members and roles**
- `GUILD_MEMBER_ADD` / `UPDATE` / `REMOVE` need **`GUILD_MEMBERS` (1<<1), which is privileged**.
- `UPDATE` carries `guild_id`, `roles`, and `user` (with `bot?`).
- `ADD` can arrive for existing members.
- `GUILD_ROLE_DELETE` falls under `GUILDS`.
- `@everyone` has the same id as the guild.
- Get Guild Roles needs no privileged intent.
- List Guild Members **requires the `GUILD_MEMBERS` privileged intent**.
- Opcode 8 "request all" is rate-limited to 1 request per 30 s per guild; it is not used.

**Gateway sessions**
- `GUILD_CREATE` is sent after a fresh `READY`, when a guild becomes available again, and when the bot joins. It is not listed for resume, and without presences its `members` is not a member list.
- A resume replays missed events. A new session replays nothing.
- Under 10k users, privileged intents are a Portal toggle. Requesting one that isn't enabled closes the connection with **4014**, reconnect = false.

**Mention data without Message Content**
- The message object has:
  - `mentions`: "users specifically mentioned in the message"
  - `mention_roles`: "roles specifically mentioned", as role ids
  - `mention_everyone`
- The Message Content intent only affects `content`, `embeds`, `attachments`, `components` and `poll` (message footnote [2]; gateway › Message Content Intent). **Mention fields do not need it.**
- The `MESSAGE_CREATE` extra fields are `guild_id?`, `member?`, **`mentions`** (user objects with a partial member) and **`channel_type?`** (optional).
- `MESSAGE_UPDATE` carries the same extra fields as `MESSAGE_CREATE`. That is irrelevant under E1.
- User objects have `bot?`, so explicit-mention bot exclusion needs no member lookup.
- `@everyone` and `@here` appear **only** as the `mention_everyone` boolean. They are never Target Sources. `<@&guildId>` is excluded explicitly.
- Forwards are identified by `message_reference.type == 1` (FORWARD) or flag `HAS_SNAPSHOT` (1<<14). `message_snapshots[].message` has its **own** `mentions` and `mention_roles`.
- Replies may carry the replied-to author in `mentions`. That doesn't matter, because replies never trigger.

**Commands and components**
- `CHANNEL` options take `channel_types`. `ROLE` and `STRING` (`max_length`) options exist.
- Resolved channels include `app_permissions`.
- Role Select allows at most 25 values and `default_values` of type `"role"`.
- `allowed_mentions {parse: []}` suppresses all pings and must be sent on **every** edit.

**UNVERIFIED — covered by the live checklist (§18):**
1. `GUILD_MEMBER_UPDATE.roles` is the full list.
2. `user.bot` is present for bots.
3. Role deletion does or does not emit per-member updates. **The design doesn't depend on it.**
4. There is no `GUILD_CREATE` after a resume.
5. List Guild Members is ordered by ascending id.
6. Thread messages carry the thread's id as `channel_id`.
7. The outer `type` of a forward.
8. Whether `mention_roles` includes a non-mentionable role mentioned by a user without permission to ping it.
9. Whether `channel_type` is present on every guild `MESSAGE_CREATE`.
10. **Whether a forward's outer `mentions` / `mention_roles` are empty, or copied from its snapshot** (E5 rule: fail closed on overlap).

### 0.3 Reusable mechanisms
- `repo.replaceTargets()`
- The pieces of `startTracking()`
- `repo.acknowledge()` (transactional authorization)
- `RenderScheduler`
- `backfillTargets` / `initialBackfill`
- `p-limit` and the existing backoff patterns
- `eligibleTargets()`
- **`SUPPORTED_CHANNEL_TYPES`**
- `Responder` and the `sb1` codec
- `timestampOf(interaction.id)`
- The ordering around `deleteUnfinishedStarts`

### 0.4 Architectural risks found
1. **Stop-reason CHECK.** Extending it forces a table rebuild (§7.1).
2. **Replays after a stop.** A replayed message could slip past the active-only index (§11).
3. **Gap-scan re-entry.** Auto creation must not live in `recordSignal` (D3).
4. **Stale member state** (§9).
5. **Huge target sets** (D8).
6. **Cross-guild policy ids** in `custom_id` (§12.4).
7. **4014 on startup** (§14).
8. **Roles deleted while offline** (§8.4).
9. **Card-edit bursts** (§9.4).
10. **R11 changes default behaviour.** It is gated by a flag (E3).
11. **Edits rewriting targets.** Prevented by the E1 freeze.
12. **Forward snapshot mentions** masquerading as the forwarder's own mentions (E5).
13. **Role-dependence under changing flags.** A naive "channel has a policy" test would wrongly stop explicit-only trackings. It is replaced by a target-based test (§14).

---

## 1. Goals
- **One auto tracking and card per qualifying top-level human message.** The trigger is explicit mentions in any supported message location, enabled role policies of an exact text or announcement channel, or both.
- **Targets are the union** of explicit users, mentioned roles and policy roles, deduplicated, excluding the author and bots.
- **Role-derived targets follow live membership and live policy.** When role state is temporarily unavailable, role-dependent cards are visibly paused. No stale state ever looks normal.
- **One pipeline** (source → resolver → desired set → reconciler) with no role logic in the tracking core.
- **Current-target-only acknowledgement** (R12).
- Restart-safe, gap-safe, idempotent, bounded, and **both flags default to off**, which gives exactly M0–M7 behaviour.

## 2. Non-goals (M9)
- No policy inheritance into threads or forum posts (D4).
- No triggers or source changes from edits (E1).
- No sources from forward snapshots (E5).
- No keyword, schedule, or other triggers.
- No saved-group, department, or external-team sources.
- No dynamic behaviour for manual trackings.
- No auto tracking of messages found by the gap scan (D3).
- No permission gates for configuration; only the authorization boundary is built.
- No Presence or Message Content intents.
- No persisted member directory or availability history, and no analytics.
- No time-based stop while paused.
- No per-viewer button visibility.

## 3. Product semantics

### 3.1 Approved requirements
1. **Dynamic role membership.** Role-derived eligibility is live.
2. **Ineligible users are removed.** Their evidence and ack for that tracking are deleted in the same transaction, and the card re-renders. There is no "former target".
3. **Union.** Targets are the union of all sources, deduplicated.
4. **Exclusions.** The author and bots are never targets. Webhook and bot messages never trigger.
5. **Top-level only.** Replies and the bot's own messages never trigger. Policies need no mention.
6. **Multiple policies per channel.** Each has a stable id, name and state, and can be edited or deleted independently. One card per message.
7. **Live policies.** A policy change reconciles active auto trackings **in that exact channel**. Nothing retroactive.
8. **Zero targets.** No tracking at creation. On reconcile, stop with `no_eligible_targets`, never to be revived.
9. **Configuration.** Any guild member may configure. Authorization is centralized.
10. **Manual independence.** Role and policy logic never mutate manual trackings. Origin is stored.
11. **R11: mention-triggered auto tracking** (details: E1–E5, §8).
    - Explicit user mentions are **fixed** sources.
    - Explicitly mentioned roles are **dynamic** sources, using the same role architecture as policies.
    - Channel-policy roles are merged in by union.
    - `@everyone` and `@here` are never sources.
    - Losing one source never removes a user another source still qualifies.
    - One card per message.
    - D8 applies to the full union.
12. **R12: acknowledgement authorization.** The public button stays public. Only a **current persisted target** can confirm, decided at click time. Rejections are ephemeral and mutate nothing. Dynamically added targets can confirm immediately. Manual trackings follow the same rule against their static targets.

### 3.2 Decisions (all approved)
| # | Decision |
|---|---|
| Q0 | Implementation is gated on the M8 baseline. |
| D2 | Re-add creates a fresh target with a fresh `added_at`. The ack and weak evidence never return. Direct replies and current reactions may be rediscovered (§6.4). |
| D3 | Only a live `MESSAGE_CREATE` creates auto trackings, for both triggers. |
| D4 | Channel policies apply to exact GUILD_TEXT and GUILD_ANNOUNCEMENT channels only, with no inheritance. |
| D5 | The author is recorded as creator (but is not a target). Manage offers Stop only for auto trackings. |
| D6 | With role targets off at startup, **role-dependent** auto trackings stop as `feature_disabled` and keep their last rows. "Role-dependent" is defined in §14. |
| D7 | Zero on reconcile deletes all targets, evidence and acks, then stops with `no_eligible_targets`. Never revived. |
| D8 | `AUTO_TRACK_MAX_TARGETS` defaults to 100 (range 1..500, startup fails outside it). It is checked after the full union excluding the author and bots, and never truncates. |
| D9 | A deleted role is pruned from policies and from message role sources. A policy that loses its last role becomes `auto_disabled_missing_role` and re-enables only from that state. |
| D10 | A forward triggers like any type-0 message (sources limited by E5). |
| D11 | `/autotrack` is always registered. |
| D12 | Every auto card carries the "Auto-tracked" label. |
| D13 / D14 | Migration technique and policy constraints. |
| D15 | Temporary operational pause for role-dependent work. It is not a stop. |
| D16 | Per-guild ordered queue. Slow REST work stays outside it. |
| P1–P3 | Grace period 60 s, edit cap 2, "Keep disabled". |
| **E1** | **Message-derived sources are frozen at `MESSAGE_CREATE`** (§8.5). |
| **E2** | **An explicit-user-only auto tracking may be created while role state is paused.** Anything with a role source fails closed (§8.1, §9). |
| **E3** | **Two independent flags, both off by default.** Mentions on with roles off means mentioned roles are ignored and policies are unavailable (§14). |
| **E4** | **The mention trigger scope equals manual `SUPPORTED_CHANNEL_TYPES`.** A missing `channel_type` fails closed. Policies stay D4-scoped (§8.1). |
| **E5** | **Forward snapshot mentions are never sources.** Only the outer, forwarder-authored mentions count. Ambiguous overlap fails closed (§8.1). |
| **E6** | **An explicit user who leaves the guild keeps their fixed source.** ExplicitUser resolution never consults member state (§5). |

---

## 4. Architecture

```
Source Message (live MESSAGE_CREATE; channel_type ∈ SUPPORTED_CHANNEL_TYPES; type 0; human)
     │  adapter: messageToAutoTrackCandidate (ids + OUTER mention arrays only; forward-safe)
     │
     ├── ExplicitUser sources      [MENTION flag]            → tracking_sources 'user'  (frozen, E1)
     ├── MentionedRole sources     [MENTION + ROLE flags]    → tracking_sources 'role'  (frozen, E1)
     └── ChannelPolicy role sources [ROLE flag; exact text/announcement channel, D4] → live
                   │
                   ▼
            TargetResolverRegistry
            ├─ ExplicitUserResolver  requiresMemberState=false  (never reads member state, E2/E6)
            └─ RoleSourceResolver    requiresMemberState=true   (MemberRoleIndex; healthy guild)
                   │
                   ▼
            Desired Target Set (union → dedupe → −author −bots → D8)
                   │
                   ▼
            TargetReconciler ── one txn ──► tracking_targets ──► Status Card (public 👀)
                   │                                                  │
                   ▼ hand-off (outside queue)                acknowledgement click
            RenderScheduler (debounce · hash-diff · cap 2)            │
                                                   current persisted target? (repo.acknowledge txn)
                                                          ├─ yes → CONFIRMED
                                                          └─ no  → ephemeral, no mutation

AutoTrackCoordinator (per-guild ordered queue) is present if EITHER flag is on.
MemberRoleIndex + GuildAutoTrackHealth + member/role/guild handlers exist only if ROLE flag is on.
```

The two triggers differ only in which sources are present. There is one pipeline, one role system and one reconciler.

### 4.1 New and changed modules
| Module | Kind | Responsibility |
|---|---|---|
| `src/domain/target-sources.ts` | new | `TargetSource` = `{type:"user"; userId}` \| `{type:"role"; roleId}` |
| `src/domain/policy-state.ts` | new | Policy state machine (§7.3) |
| `src/domain/eligibility.ts` | changed | The cap is passed in by the caller: manual keeps 25; auto uses the limit check, never truncation |
| `src/app/target-resolution.ts` | new | Registry (union, dedupe, exclusions); `requiresMemberState(sources)` |
| `src/app/explicit-user-resolver.ts` | new | Static; **never consults member state** |
| `src/app/role-source-resolver.ts` | new | Resolves both message roles and policy roles from `MemberRoleIndex` |
| `src/app/member-role-index.ts` | new | In memory. Referenced roles = policy roles ∪ message roles of active auto trackings |
| `src/app/guild-auto-track-health.ts` | new | Runtime-only health (§9.1) |
| `src/app/role-dependence.ts` | new, pure | `dependsOnRoleState(T, flags)` (§14): the single definition used by the pause gate, pause notice, and D6 sweep |
| `src/app/target-reconciler.ts` | new | Desired → limit → one-txn diff → stop reasons → hand-off |
| `src/app/auto-track-coordinator.ts` | new | Per-guild ordered queue |
| `src/app/policy-service.ts` | new | Policy CRUD and transitions |
| `src/app/config-authorizer.ts` | new | Authorization boundary |
| `src/app/backfill-queue.ts` | new | `p-limit(2)`, coalesced |
| `src/app/render-scheduler.ts` | changed | Global edit cap of 2; pause-aware `CardView` |
| `src/app/tracking-service.ts` | changed | `insertAutoTracking()` (tracking + sources + targets in one txn), `publishAutoCompanion()`, pause-aware `renderCard()`. Manual path unchanged |
| `src/app/startup-recovery.ts` | changed | `stopRoleDependentAutoTrackingsWhenDisabled()` |
| `src/app/ports.ts` | changed | `listGuildMembers`, `getGuildRoleIds`, `CardView.autoTrackPaused?` |
| `src/db/migrations/0002_auto_track.ts` | new | Rebuild `tracked_messages`; `tracking_sources`; policy tables; indexes |
| `src/db/migrator.ts` | changed | FKs off around the migrator, then `foreign_key_check` |
| `src/db/repository.ts` (+ `policy-repository.ts`) | changed/new | Origin-aware queries, reconcile, `stopAuto`, sources, policies, pruning |
| `src/discord/adapters/message.ts` | changed | `messageToAutoTrackCandidate()` (E4 scope, E5 forward rule). `messageToSignal` untouched |
| `src/discord/adapters/member.ts`, `guild.ts` | new | Member, role and guild adapters |
| `src/discord/intents.ts` | changed | `buildIntents({ roleTargetsEnabled })` |
| `src/discord/gateway.ts` | changed | Dispatch cases per flag; `Ready` resets health; 4014 is fatal |
| `src/discord/commands.ts` | changed | Adds `/autotrack`; `Track Seen` unchanged |
| `src/discord/interactions/config/*.ts` | new | `/autotrack` and the policy panel |
| `src/discord/interactions/router.ts` | changed | Chat input, modal submit, new `sb1` actions |
| `src/discord/interactions/buttons.ts` | changed | Auto Manage offers Stop only; the ack path is the R12 authorization point |
| `src/discord/render/card.ts`, `text.ts` | changed | Stop lines, "Auto-tracked", pause notice, overflow |
| `src/config.ts` | changed | `MENTION_AUTO_TRACK_ENABLED`, `ROLE_TARGETS_ENABLED`, `AUTO_TRACK_MAX_TARGETS` |

---

## 5. Target Source model (final)

```ts
export type TargetSource =
  | { type: "user"; userId: Snowflake }   // ExplicitUser — fixed, from the outer message at MESSAGE_CREATE
  | { type: "role"; roleId: Snowflake };  // MentionedRole (frozen reference, dynamic membership) or PolicyRole (live)

export interface TargetSourceResolver<S extends TargetSource = TargetSource> {
  readonly type: S["type"];
  readonly requiresMemberState: boolean;                     // user: false · role: true
  resolve(source: S, ctx: { guildId: Snowflake }): { userId: Snowflake; bot: boolean | undefined }[];
}
```

| Source | Stored where | Reference | Membership | Available when |
|---|---|---|---|---|
| **ExplicitUser** | `tracking_sources` `('user', id)` | Frozen at create (E1) | Fixed. **Never consults member state** (E2, E6) | Mention flag on |
| **MentionedRole** | `tracking_sources` `('role', id)` | Frozen at create (E1); pruned on role delete (D9) | Dynamic via `MemberRoleIndex` | Mention **and** role flags on |
| **ChannelPolicy role** | `auto_track_policy_sources` | Live (policy CRUD, D9 pruning) | Dynamic via `MemberRoleIndex` | Role flag on; exact text/announcement channel (D4) |

- **One role-membership system.** `MemberRoleIndex`'s referenced roles are the policy roles in the guild ∪ the message roles of active auto trackings.
- **Explicit user who leaves the guild (E6, known M9 behaviour).** The source stays and they remain a target. This matches manual tracking. The tracking ends through its normal lifecycle.
- **Role-derived users who leave** are removed, as before.

---

## 6. Reconciliation design

### 6.1 Desired state (flag-aware)
For an active tracking `T` with `origin = 'auto'`:

```
sources(T) = tracking_sources(T) filtered to types whose flag is on        -- 'role' rows need ROLE flag
           ∪ (ROLE flag on ∧ channel type text/announcement (D4))
               ? { role S of P : P.channel_id = T.channel_id ∧ P.state='enabled' } : ∅
desired(T) = exclusions(⋃ resolve(S), author = T.source_author_id, bots)
```

- A policy on a parent channel never matches a thread's `channel_id`, so there is no inheritance (D4).
- With role targets **off**, the reconciler never runs for role-dependent trackings: they were stopped at startup by D6 (§14). Explicit-only trackings never need reconciling.

### 6.2 `TargetReconciler.reconcile(T)` (inside the guild queue)
1. If `requiresMemberState(sources(T))` and the guild is paused → skip (temporary pause).
2. Compute `desired(T)`.
3. **D8.** If `|desired| > L`, call `stopAuto(T, 'target_limit_exceeded')` **without** any diff (the last rows are kept) and go to step 5.
4. **One transaction.** Only rows with `stopped_at IS NULL AND origin='auto'` are touched.
   - Removed users lose their targets, evidence and acks.
   - If the desired set is empty: delete everything, then stop with `no_eligible_targets` (D7).
   - Otherwise insert the added users with `added_at = at` and `added_by = '0'`.
5. Hand off `markDirty` and backfill-for-added outside the queue.

Gateway handlers never add or remove targets directly.

### 6.3 Stop-reason semantics
| Stop reason | Targets / evidence / acks | Card | Reconciled later? |
|---|---|---|---|
| `no_eligible_targets` | Deleted, then stopped | Stop line, no rows | Never |
| `target_limit_exceeded` | Kept (last accepted set) | Stop line + last rows | Never |
| `feature_disabled` | Kept | Stop line + last rows | Never |
| Existing reasons | Unchanged | Unchanged | Never |

A tracking with at least one stored explicit user can never reach `no_eligible_targets`, because explicit sources are fixed and never depend on member state.

### 6.4 `added_at`, removal and re-add (D2)
- **Fresh target:** `added_at` is the processing time. Weak evidence counts only from `max(createdAt, addedAt)` to `weakWindowEndsAt`.
- **Removal:** target, evidence and ack are deleted in one transaction.
- **Re-add:** a fresh target with a new `added_at`, followed by a backfill.

| State before removal | On re-add |
|---|---|
| Ack | **Never returns** |
| Weak evidence | **Never returns** |
| Direct reply | May be rediscovered (1,000-message cap) |
| Reaction that still exists | May be rediscovered (no time shown) |

Explicit users are never removed by role changes, so D2 only concerns users qualified through role sources. Regression test: #32b.

### 6.5 Safety limit (D8)
- Default 100, range 1..500; startup fails outside that range.
- Counted after the **full union of the sources available under the current flags**, deduplicated, excluding the author and bots.
- The target set is never truncated.

| Point | Behaviour when over the limit |
|---|---|
| Policy config (target-increasing change) | Worst case: the channel's policy union, bots excluded (the author is unknown at config time). The change is rejected and not committed. If the guild is paused, it is rejected as unavailable. |
| New message (either trigger) | No tracking and no card. A rate-limited warning is logged. |
| An active tracking grows | Stops with `target_limit_exceeded`; its rows are kept. |
| Manual | Unaffected. |

### 6.6 Card display for many targets
- At most 25 lines, then "+N more".
- Counts always reflect the full set.
- The manual card is byte-identical to today's.

---

## 7. Persistence and schema changes (migration `0002_auto_track`)

### 7.1 Rebuild `tracked_messages`
**FK handling around the migrator**
- Turn FKs off **before** the migrator (outside its transaction).
- Afterwards, run `foreign_key_check`; any row is a startup error. Then turn FKs back on.

**Inside the migrator's transaction**
1. Create the new table.
2. `INSERT … 'manual'`.
3. Drop the old table and rename the new one.
4. Recreate the 7 existing indexes plus the new ones.
5. Set `sqlite_sequence.seq = max(old seq, max(id))`.

```sql
origin      TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','auto')),
stop_reason TEXT CHECK (stop_reason IN
  ('manual','expired','source_deleted','status_deleted','channel_deleted',
   'no_eligible_targets','feature_disabled','target_limit_exceeded')),
```

No stop reason is added for the pause.

### 7.2 `tracking_sources` (message-derived sources)
```sql
CREATE TABLE tracking_sources (
  tracked_message_id INTEGER NOT NULL REFERENCES tracked_messages(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL,   -- 'user' | 'role'  (app-validated)
  source_ref         TEXT NOT NULL,   -- snowflake
  PRIMARY KEY (tracked_message_id, source_type, source_ref)
) WITHOUT ROWID;
CREATE INDEX ix_tracking_sources_ref ON tracking_sources(source_type, source_ref);
```

- **When written:** only for `origin = 'auto'`, in the phase-A transaction.
- **Frozen afterwards (E1).** The only mutations are:
  - D9 pruning of a deleted role
  - `forget-user` deleting a user's `user` rows
  - cascade on purge
- **What is written:**
  - `user` rows: only if the mention flag is on — outer-message explicit mentions minus bots and minus the author.
  - `role` rows: only if **both** flags are on — outer `mention_roles` minus the guild id.
  - With role targets off, role mentions are **ignored**, and ignored roles never come back later (E1, E3).
- **Never written:** `mention_everyone`, snapshot mentions (E5), ambiguous forward mentions (E5), bot ids, author ids.
- Manual trackings store no sources.
- Ids only; no content and no names.

### 7.3 Policy tables and state (approved in rev 3)
```sql
CREATE TABLE auto_track_policies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id           TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  state              TEXT NOT NULL DEFAULT 'enabled'
                     CHECK (state IN ('enabled','user_disabled','auto_disabled_missing_role')),
  state_changed_at   INTEGER NOT NULL,
  state_changed_by   TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL,
  updated_at         INTEGER NOT NULL,
  updated_by_user_id TEXT NOT NULL
);
CREATE TABLE auto_track_policy_sources (
  policy_id        INTEGER NOT NULL REFERENCES auto_track_policies(id) ON DELETE CASCADE,
  source_type      TEXT NOT NULL,   -- 'role'
  source_ref       TEXT NOT NULL,
  added_at         INTEGER NOT NULL,
  added_by_user_id TEXT NOT NULL,
  PRIMARY KEY (policy_id, source_type, source_ref)
) WITHOUT ROWID;
```

**Invariant:** an enabled policy has at least one source.

**State transitions:**

| From | Event | To |
|---|---|---|
| `enabled` | User disables | `user_disabled` |
| `enabled` | Last role deleted | `auto_disabled_missing_role` |
| `auto_disabled_missing_role` | User adds a role | `enabled` (only if the guild is healthy and the D8 check passes) |
| `auto_disabled_missing_role` | "Keep disabled" | `user_disabled` |
| `user_disabled` | User adds a role | stays `user_disabled` |
| `user_disabled` | Last role deleted | stays `user_disabled` |
| `user_disabled` | User enables | `enabled` (needs ≥1 source, a healthy guild, and the D8 check) |

### 7.4 Types
- `origin`: `"manual" | "auto"`.
- `StopReason` gains 3 values.
- New types: `TargetSource`, `PolicyState`, `AutoTrackPolicy`, `PolicySource`.

---

## 8. Event handling

### 8.1 Auto-track creation (live `MESSAGE_CREATE` only; D3, E2–E5)

**Adapter** `messageToAutoTrackCandidate(d, flags)` returns a candidate **only** if:
- `guild_id` is present
- `type === 0` (so replies are excluded)
- `!author.bot` and no `webhook_id` (so the bot's own card can never trigger)
- **E4:** `channel_type` is present **and** in `SUPPORTED_CHANNEL_TYPES`, the same set manual Track Seen uses: text, announcement, and public/private/announcement threads (forum and media posts are public threads).
  - If `channel_type` is **missing**, fail closed: no candidate and a debug log. The bot has no authoritative channel cache and adds no per-message REST lookup.

**Outer mentions (E5)**
- `outerUsers` = `mentions[]` with bots and the author removed.
- `outerRoles` = `mention_roles[]` with the guild id removed.
- If the message is a **forward** (`message_reference.type == 1` or `flags & HAS_SNAPSHOT`), snapshot mentions are never read. Additionally, drop from `outerUsers` / `outerRoles` any id that also appears in a snapshot's `mentions` / `mention_roles`. Such an overlap is ambiguous (it may have been copied from the snapshot), so it fails closed.
- Outer mentions **not** present in the snapshot are the forwarder's own and are kept.
- The real payload shape is recorded in manual check M9-33.

**Flag filtering (E3)**
- `explicitUserIds = outerUsers` only if the MENTION flag is on.
- `mentionedRoleIds = outerRoles` only if the MENTION **and** ROLE flags are on; otherwise they are ignored.
- `mention_everyone` is ignored.
- `content` is never read.

**Wiring**
- If **either** flag is on, the candidate goes to `coordinator.onTopLevelMessage()`.
- `recordSignal` is unchanged.
- The gap scan never reaches the coordinator (D3).

**Phase A — inside the guild queue:**
1. **Sources.** Explicit users and mentioned roles come from the candidate. Policy roles are added only if the ROLE flag is on **and** `channel_type` is GUILD_TEXT or GUILD_ANNOUNCEMENT, via an exact `channel_id` lookup (D4: a thread never matches its parent's policy). If there are no sources, stop (fast path).
2. **Pause check (E2).**
   - If `requiresMemberState(sources)` (any mentioned role or policy role) and the guild is paused: **fail closed**. Create nothing (no partially resolved role-dependent tracking) and log at debug level.
   - If only explicit-user sources are present: proceed even while paused. This does not touch member state.
3. Compute `desired`. If it is empty, create no row (so `@Dev`-only with the ROLE flag off means zero sources and no card).
4. D8: if over the limit, log (rate-limited) and create no row.
5. `insertAutoTracking()` in **one transaction**:
   - the tracked message with `origin = 'auto'` and creator = author
   - its `tracking_sources`
   - its targets with `added_at = createdAt`
   - `status_message_id` left NULL

   Any active tracking for the message, or a unique conflict, is a silent skip.

**Phase B — outside the queue:**
- `publishAutoCompanion(T)`: pause-aware render, nonce, `fail_if_not_exists`, `allowed_mentions {parse: []}`.
- Success: store the status message id, then `markDirty`.
- Failure: roll back and log a warning, rate-limited per channel. Example: missing permissions in a thread or unconfigured channel, since `MESSAGE_CREATE` has no `app_permissions`.
- Then enqueue `initialBackfill`.

### 8.2 Member and guild events (ROLE flag on only)
| Event | Task |
|---|---|
| `READY` | All guilds → `awaiting_guild` |
| `GUILD_CREATE` | Rebuild and recover (§9.2) |
| `GUILD_MEMBER_ADD` / `UPDATE` | If paused: drop. Otherwise `index.upsert`; if referenced-role membership changed, reconcile the active auto trackings whose `sources(T)` contain the old or new roles |
| `GUILD_MEMBER_REMOVE` | If paused: drop. Otherwise `index.remove`, then reconcile where the user is a target. **Explicit sources keep the user (E6)** |
| `GUILD_DELETE` + `unavailable` | → `unavailable` |
| `GUILD_DELETE` (removed) | Existing purge + policies; drop index and health |
| `CHANNEL_DELETE` | Existing stop + delete that channel's policies |
| `GUILD_ROLE_DELETE` | §8.4 |

With the ROLE flag off, none of these handlers is attached and the privileged intent isn't requested.

### 8.3 Policy changes (inside the queue; ROLE flag on)
- Tenant check, state machine, `@everyone` rejected.
- **Target-increasing** changes need a healthy guild, an index extension, and the D8 check; otherwise they are rejected.
- **Target-decreasing** changes are always committed; the reconcile is deferred to recovery if the guild is paused.
- The reconcile covers every active auto tracking in **that exact channel**, whichever trigger created it. Threads are never covered (D4).

### 8.4 Role deletion (D9)
One transaction:
1. Delete the policy source rows for the role and apply the state machine.
2. Delete the `('role', role)` rows in `tracking_sources` for the guild's active auto trackings.

Then `index.dropRole` and reconcile. Other sources, including explicit users, still qualify their users. Zero targets → D7. If the guild is paused: commit the cleanup and reconcile at recovery.

**Offline deletions** are handled at each rebuild via Get Guild Roles, for both tables, and only after a successful fetch.

### 8.5 Message edits (E1, approved): frozen at `MESSAGE_CREATE`
- `MESSAGE_UPDATE` **never**:
  - changes ExplicitUser or MentionedRole sources
  - adds or removes targets
  - creates an auto tracking for a message that wasn't tracked at creation
- Example: `@An check this` edited to `@Binh check this` → the tracking keeps `ExplicitUser(An)`, and Binh is not added.
- Role membership (for MentionedRole and policy roles) and channel-policy configuration remain dynamic.
- Implementation consequence: no `MESSAGE_UPDATE` handler is added for auto tracking. The existing adapters don't consume it either.

---

## 9. Member-state recovery and temporary pause (D15, E2; ROLE flag on)

### 9.1 Runtime health (never persisted)
| State | Meaning | Paused |
|---|---|---|
| `awaiting_guild` | Process start; every fresh `READY` | yes |
| `rebuilding` | Rebuild in progress | yes |
| `reconciling` | Recovery reconcile in progress | yes |
| `failed` | Rebuild failed; retry scheduled | yes |
| `unavailable` | Discord outage | yes |
| `healthy` | Normal | no |

`pausedSince` and `attempt` are kept in memory only. No guild is healthy after a restart until its initial rebuild and reconcile succeed.

**What the pause affects: role-dependent work only.** A candidate or tracking counts as role-dependent if `requiresMemberState(sources)` is true.
- **Blocked:** creation and target mutation. Target-increasing policy changes are rejected; decreasing ones are saved. Member events are dropped.
- **Unaffected:** explicit-only candidates (E2, created normally), explicit-only auto trackings, and manual trackings.
- **Still lifecycle-active:** no `stopped_at`, last known good targets and evidence kept. Evidence, ack/undo, Stop and expiry all keep working.

### 9.2 Rebuild and recovery
Runs for guilds with enabled role policies **or** active role-dependent auto trackings. Globally `p-limit(1)`.

**Triggers:** `GUILD_CREATE`, growth of the referenced role set, retry timers. `RESUMED` triggers nothing.

1. `rebuilding`
2. Get Guild Roles, then prune deleted roles in both tables. On failure → step 6.
3. List Guild Members, keeping members of referenced roles (policy ∪ message). On failure → step 6.
4. `reconciling` → `reconcileGuild()`, which applies deferred removals.
5. `healthy` → log "resumed" → refresh cards (§9.4).
6. **Failure:** `failed`, log "paused", back off 1 m / 5 m / 15 m / then every 15 m (a 403 gets a Portal hint), show "paused" in `/autotrack list`.

Member events that arrive during a rebuild queue behind it. A DB failure while reconciling keeps the state at `reconciling` and retries after 60 s.

### 9.3 Pause notice
`autoTrackPaused` is true only when **all** of these hold:
- the tracking is auto and active
- it is role-dependent
- the guild is paused

Explicit-only auto cards and manual cards never show it.

The text is `-# ⏸ Auto-track temporarily paused — member state is unavailable. Last known targets are shown.` It is part of the hash, and any render while paused shows it.

### 9.4 Refresh without a stampede
- Global edit cap of 2, plus the existing debounce and hash-diff.
- **Entering a pause:** a 60 s grace, after which only the guild's role-dependent active auto cards are marked dirty.
- **Resume:** mark the same set dirty; hash-diff limits edits to cards that actually changed.
- Result: zero edits for routine restarts, and at worst one edit per affected card with at most 2 in flight.

---

## 10. Queue, concurrency, queries (D16)

**Inside the queue:** health transitions, rebuild, member events, policy commits, diffs, and phase A (both triggers).

**Outside the queue:** publish, render, backfill, and grace timers.

**Limits:** rebuild 1, backfill 2, edits 2.

**Indexes (in 0002):**

| Lookup | Index |
|---|---|
| guild/channel → active auto trackings | `ix_tracked_active_auto ON tracked_messages(guild_id, channel_id) WHERE stopped_at IS NULL AND origin='auto'` |
| channel → enabled policies | `ix_policies_channel_enabled ON auto_track_policies(channel_id) WHERE state='enabled'` |
| guild → policies | `ix_policies_guild ON auto_track_policies(guild_id)` |
| role → policies | `ix_policy_sources_ref ON auto_track_policy_sources(source_type, source_ref)` |
| tracking → message sources | `tracking_sources` PK prefix |
| role → trackings | `ix_tracking_sources_ref ON tracking_sources(source_type, source_ref)` |
| tracking + user → target (reconcile, **ack authorization**) | existing PK `tracking_targets` |
| auto uniqueness | `ux_tracked_auto_source ON tracked_messages(source_message_id) WHERE origin='auto'` |

---

## 11. Idempotency
| Case | Mechanism |
|---|---|
| Replayed `MESSAGE_CREATE` (active / after stop) | `ux_tracked_active_source` / permanent `ux_tracked_auto_source` → skip |
| Mention message in a policy channel | One candidate → one phase-A task → one row |
| Manual tracking already active | Silent skip |
| Crash between phase A and B | `deleteUnfinishedStarts` (its sources cascade) |
| `MESSAGE_UPDATE` (any number) | No effect on auto tracking (E1) |
| Duplicate member updates / ADD for an existing member | Idempotent upsert; `unchanged` |
| Duplicate role delete / prune | No-op |
| Duplicate policy tasks; pause/resume flapping | Coalesced; hash-diff |
| Double ack | `already` + Undo |
| Ack racing a removal | Serialized SQLite write transactions (§12.6) |
| Stopped tracking | Never reconciled or revived |
| D6 sweep | Idempotent |

---

## 12. Configuration UX and interactions

### 12.1 `/autotrack` (ROLE feature)
- Subcommands: `create channel name role` and `list [channel]`. Replies are ephemeral and deferred.
- The command is always registered (D11). No `default_member_permissions`. Guild only.
- The `channel` option takes `channel_types: [GUILD_TEXT, GUILD_ANNOUNCEMENT]` (D4).
- `list` shows "Mention auto-track: on/off" and "Role targets: on/off", plus "paused" / "over limit".
- With the ROLE flag off, every `/autotrack` interaction gets an ephemeral "Role-based auto-track is disabled (ROLE_TARGETS_ENABLED=false)". Mention auto-track has no configuration in M9.

### 12.2 Policy panel (rev 3)
- **Role Select** (min 1, max 25). Adding a role re-enables only an `auto_disabled_missing_role` policy.
- **State button** (Disable / Enable / Keep disabled), **Rename** (modal), **Delete** (confirmation), and the list select.
- Ephemeral, with `allowed_mentions {parse: []}`.

### 12.3 Validation (D14)
- Name is 1–100 characters.
- An enabled policy needs at least one role.
- At most 25 policies per channel.
- Text or announcement channels only.
- `@everyone` is rejected.
- The D8 limit applies.
- Warn about missing bot permissions via the resolved `app_permissions`.

### 12.4 Config authorization
- A single `ConfigAuthorizer`: any guild member in M9.
- Tenant isolation is always enforced.

### 12.5 Auto cards (D5, D12)
- "Auto-tracked ·" appears on every auto card.
- States and precedence are unchanged.
- Manage offers Stop only; `sb1:targets` is refused.
- The pause notice appears only on role-dependent cards.
- Stop lines as in rev 3.

### 12.6 Acknowledgement authorization (R12): current persisted target only

**Single decision point:** the `repo.acknowledge()` write transaction. Identity comes from `member.user.id`.

**Handler flow:**
1. Tracking missing → orphan self-heal.
2. `interaction.message.id` must equal `status_message_id`; otherwise reply "outdated".
3. Tracking stopped → ephemeral "ended".
4. **One transaction:** check for a `tracking_targets(trackedId, userId)` row.
   - **No row** → `not_target`: no write and no render. Ephemeral *"You're not a tracked target for this message."*
   - **Row present** → `already` (ephemeral + Undo) or `acknowledged` (UPDATE_MESSAGE with a fresh card).

**Cases**

| Case | Outcome and reason |
|---|---|
| Author of an auto tracking | Never a target (excluded at create and in every `desired`) → rejected |
| Any non-target | No row → rejected, with no write |
| Target removed dynamically | Row, evidence and ack deleted by the reconciler → rejected. Never recreated or restored |
| Target added dynamically | Row inserted → the existing public button works immediately |
| Still qualified by another source (e.g. ExplicitUser + lost `@Dev`) | Row kept (union) → may confirm |
| Stale card or button | Persisted state checked at click time; `message.id` must match |
| Restart | Stateless handler, SQLite state |
| Ack racing a reconcile | Single SQLite write transactions serialize: ack-then-removal deletes the ack; removal-then-ack rejects it |
| Temporary pause | Persisted last-known-good targets can confirm. Recovery removes the ack if the user is no longer eligible |
| After an edit (E1) | Targets unchanged by the edit, so authorization follows the unchanged rows. A user newly mentioned by the edit is rejected |
| Forward snapshot user (E5) | Never a source, so never a target → rejected |
| Explicit target left the guild (E6) | Still a persisted target (they can't see the card; no special handling) |
| Thread mention tracking (E4) | Same rule |
| Manual tracking | Same rule against static targets. Role/policy logic never touches manual rows |

**Undo** only revokes the caller's own ack on a current target row. A rejected undo writes nothing.

---

## 13. Failure handling
| Failure | Behaviour |
|---|---|
| ROLE flag on, Portal intent off | 4014 → fatal log, exit non-zero |
| Rebuild failure | Temporary pause (role-dependent work only); logged; backoff |
| DB failure while reconciling | Stay `reconciling`; retry after 60 s |
| DB failure in phase A | Logged; message not auto-tracked |
| Missing `channel_type` | No candidate (fail closed); debug log |
| Companion post failure (e.g. permissions in a thread or unconfigured channel) | Rollback; rate-limited warning per channel |
| Card edit failure | Existing mapping |
| Guild outage | `unavailable` → rebuild at `GUILD_CREATE` |
| Over the limit | §6.5 |

---

## 14. Feature flags, intents, and role-dependence (E3, D6)

### 14.1 Flag / intent matrix (final)
| `MENTION_AUTO_TRACK_ENABLED` | `ROLE_TARGETS_ENABLED` | Gateway intents | Sources collected at creation | Policies / `/autotrack` | Member state / pause |
|---|---|---|---|---|---|
| false (default) | false (default) | **3585** (GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, GUILD_MESSAGE_TYPING) | none: **no auto tracking; exactly M0–M7** | Unavailable ("disabled" reply) | none |
| true | false | **3585** (no privileged intent) | **ExplicitUser only.** Mentioned roles are ignored; `@Dev`-only → zero sources → no card; `@An @Dev` → tracking for An | Unavailable | none (explicit-only is never paused) |
| false | true | **3587** (+ GUILD_MEMBERS) | ChannelPolicy roles only. Message mentions are not collected | Available | Yes |
| true | true | **3587** | ExplicitUser + MentionedRole + ChannelPolicy roles | Available | Yes, for role-dependent work |

**Presence and Message Content are never requested.** `assertIntents` forbids them unconditionally and allows `GUILD_MEMBERS` only when `ROLE_TARGETS_ENABLED=true`.

`AUTO_TRACK_MAX_TARGETS` defaults to 100 (range 1..500) and applies whenever auto tracking is on.

### 14.2 Role-dependence: one definition (`role-dependence.ts`)
- **ROLE flag on** (pause gate, notice, reconcile gating):
  `dependsOnRoleState(T) = requiresMemberState(sources(T))`, i.e. T has a message `role` source, **or** its exact text/announcement channel has an enabled policy with role sources.
- **ROLE flag off** (D6 startup sweep):
  `dependsOnRoleState(T) = T has any tracking_sources 'role' row  OR  T has any target not in its tracking_sources 'user' rows`. In words: its current targets include users that only a role could have qualified.
  - **Why target-based:** an explicit-only tracking created while roles were off, in a channel whose (then inert) policy exists, has only explicit targets, so it is **not** stopped.
  - A tracking created while roles were on, with policy-derived targets, **is** stopped, because those targets can no longer be maintained.

### 14.3 Startup with the ROLE flag off (D6)
`stopRoleDependentAutoTrackingsWhenDisabled()` runs after migrations and `deleteUnfinishedStarts`, before the gateway is created.
- Every active `origin='auto'` tracking with `dependsOnRoleState` → `feature_disabled`. Last rows are kept; the card says it ended; it is never reconciled.
- **Explicit-only auto trackings keep running** (static sources). Manual trackings are never selected.
- Idempotent. Refreshes go through the scheduler (cap 2).
- **Mixed trackings** (explicit + role) stop entirely rather than silently shrinking to their explicit users. Shrinking would delete role-derived users' evidence under a configuration change.

**With the MENTION flag off:** no new mention trackings. Existing auto trackings continue: explicit sources are static, and role sources follow the ROLE flag.

### 14.4 Rollout
1. The M8 baseline passes.
2. Deploy with both flags off: the migration and command registration only.
3. Optionally turn on the MENTION flag (no Portal change).
4. For roles: enable Server Members in the Portal, then set `ROLE_TARGETS_ENABLED=true`.
5. Run the M9 checklist.

**Rollback:** turn the flags off and restart.

## 15. Privacy and retention
**New persisted data**
- Policy configuration, kept until deleted.
- `tracking_sources`: the ids of explicitly mentioned users and roles per auto tracking, under the tracking's 7-day / 30-day retention.

**In memory only:** referenced-role membership, bot flags, and per-guild health. No member directory and no availability history are persisted.

**Unchanged:** expiry, purge, immediate deletion of an ineligible user's evidence and ack, and the destructive `no_eligible_targets`.

**System changes:** role deletion prunes both policy and message sources. Channel deletion deletes its policies. Removing the bot purges the guild's policies.

**`forget-user`:** also deletes `tracking_sources` user rows and anonymizes policy actors.

**Never collected:** content, snapshot mentions (E5), presence, names, a member directory, or history.

**PRIVACY.md will state:**
- the collected data
- the Server Members intent (when role targets are on)
- that any member can configure policies
- that when mention auto-track is enabled, **mentioning someone can auto-create a status card**

## 16. Testing strategy
TDD throughout. All existing tests stay green. Coverage stays at or above statements 90.33 %, branches 80.34 % and lines 94.01 %, with domain/app line coverage at or above 90 %.

**Rev 3 tests** (kept; generalized for sources)
- 1–5: single role, union, dedupe, author and bot exclusion
- 6–10: triggers; multiple policies → one card
- 11–14: policy reconcile per exact channel, both triggers
- 15–20b: member events, role delete, policy state machine
- 21–23b: zero targets, destructive `no_eligible_targets`, history kept
- 24–25: manual isolation
- 26–27: restart and `GUILD_CREATE` recovery; `RESUMED` does nothing
- 28–32b: idempotency, bounds, D2 regression
- 33–36: config authorization, flags, intents, no pings
- 37–39: D8, pause, notice, no stampede, D16 phases

**R11: mention auto-track** (`unit/adapters-auto-track.test.ts`, `unit/target-resolution.test.ts`, `integration/mention-auto-track.test.ts`)

| # | Test |
|---|---|
| M1 | Explicit `@user` in an **unconfigured** text channel → auto tracking + `tracking_sources` user row |
| M2 | Role mention in an unconfigured channel (both flags on) → role members; role row |
| M3–M5 | `@everyone`, `@here`, and `<@&guildId>` are not sources |
| M6 | Top-level triggers; reply / bot / webhook / our card do not |
| M7 | Author self-mention or author holding the role → excluded; bots excluded |
| M8 | Dedupe: duplicate mentions; same user via two roles; explicit + role; message role + policy role |
| M9 | Mention + policy (exact channel) → **one** card with the union; a later policy merges into an existing mention tracking |
| M10 | Explicit user remains after losing an overlapping role; mentioned role reconciles (An,Binh → An,Lan) |
| M11 | Replayed `MESSAGE_CREATE` → no duplicate; sources inserted once |
| M12 | Limit after the full union: 101 → none + log; 100 → created |
| M13 | Zero eligible (only bots, the author, or an empty role) → none |
| **M14a** | **Mentions on, roles off, `@user`** → tracking for the user; intents 3585 |
| **M14b** | **Mentions on, roles off, `@role` only** → zero sources → no tracking or card |
| **M14c** | **Mentions on, roles off, `@user` + `@role`** → tracking for the user only; **no** role row stored; later turning roles on doesn't add the role (E1) |
| M14d | Mentions off → no mention trigger; policies still trigger when roles are on (message mentions not collected) |
| **M15a** | **Role state paused + explicit-only message** → created; **no** pause notice |
| **M15b** | **Role state paused + explicit user + role source** (a mentioned role, or a policy in the exact channel) → **nothing created** (no partial tracking) |
| M16 | Role deletion prunes the `tracking_sources` role row; explicit users remain; zero → D7 |
| M17 | D6 target-based sweep: explicit-only (even in a channel with an inert policy) → kept; mixed or role-derived → `feature_disabled`; manual untouched |
| M18 | `forget-user` removes user source rows |
| **M19** | **Mention in a supported thread and in a forum post** → auto tracking (message sources only); `channel_type` missing → none; unsupported `channel_type` (e.g. voice text) → none |
| **M20** | **A policy on the parent channel does not apply to a thread**: a thread message with no mentions → none; with mentions → only message-derived targets; a policy change on the parent never reconciles thread trackings |
| **M21** | **Forward: snapshot mentions ignored** (a snapshot containing `@Dev @Binh` contributes nothing) |
| **M22** | **Forward: outer forwarder-authored mentions kept** (outer `@An` not in the snapshot → ExplicitUser(An)); outer ids overlapping the snapshot → dropped (fail closed) |
| **M23** | **An explicit target leaves the guild** (`GUILD_MEMBER_REMOVE`) → remains a target; a role-derived user who leaves → removed; the tracking ends by the normal lifecycle |

**Edits (E1)** (`integration/message-update.test.ts`)

| # | Test |
|---|---|
| **#40a** | Edit `@An` → `@Binh` after tracking starts → sources and targets unchanged (An stays, Binh absent); An's ack is preserved |
| #40b | Editing an untracked message to add mentions → no tracking |
| #40c | Role membership and policy changes still reconcile after an edit |

**R12: acknowledgement authorization** (`integration/ack-authorization.test.ts`)

| # | Test |
|---|---|
| A1 | Current target confirms → CONFIRMED, count +1 |
| A2 | Author clicks their own auto card → rejected, 0 writes |
| A3 | Non-target → rejected, 0 writes |
| A4 | Dynamically removed target → rejected; not recreated or restored |
| A5 | Dynamically added target → the existing button confirms immediately |
| A6 | Still eligible via another source → confirms |
| A7 | Rejected click → no evidence or ack rows, no render |
| A8 | Stale card (row deleted after render) → rejected; wrong message id → outdated |
| A9 | Restart → same outcomes |
| A10 | Manual target confirms; manual non-target rejected; role/policy changes don't alter manual |
| A11 | Ack racing a removal → consistent final state |
| A12 | Paused: persisted target confirms; after recovery removes them, the ack is gone |
| **A13** | **Composite matrix after M14a–c, M15a–b, #40a, M19–M23:** for each resulting tracking, **exactly** the persisted current targets can confirm: roles-off `@Dev` users rejected; edited-in Binh rejected; snapshot users rejected; outer forwarder mentions accepted; thread targets accepted; the parent-policy user in a thread rejected; an explicit user who left remains authorized (no special handling) |

**Migration (#41):** rows and children kept, origin `manual`, sequence preserved, FK check clean, new CHECK values present, policy state CHECK, `tracking_sources` cascade.

**Fakes:** paged members and guild roles; gateway member/role/guild/ready events; message-with-mentions / forward / thread fixtures.

## 17. Migration and backward compatibility
- 0002 runs on start and marks existing rows `origin='manual'`.
- **With both flags off (the default), behaviour equals M0–M7** apart from a no-op sweep and a behaviour-preserving edit cap.
- All 231 existing tests must pass.
- `Track Seen` is unchanged; `/autotrack` is added. Migrations are forward-only.

## 18. Manual test plan (M9 section)

**Preconditions**
- **The M8 baseline has passed.**
- Portal: Server Members on; Message Content and Presence off.
- Limit 100. Flags as stated per item.
- Roles `@Dev`, `@QA` and `@Security`.
- Accounts:

  | Account | Roles |
  |---|---|
  | A | author, `@Dev` |
  | B | `@Dev` |
  | C | `@QA` |
  | D | `@Dev` + `@QA` |
  | E | none |

- Also: a text channel #important with a policy, an unconfigured #general, a public thread under #important, and a forum channel.

**Rev 3 items M9-1 … M9-21** (policy flows, both flags on) are kept.

**Rev 4/5 items**

| # | Flags | Check |
|---|---|---|
| M9-22 | M+R | In #general, A sends "@B @E please review" → one "Auto-tracked" card, targets B and E, nobody pinged. |
| M9-23 | M+R | "@QA please check" in #general → C and D. E gains `@QA` → appears. C loses `@QA` → removed. |
| M9-24 | M+R | "@everyone" / "@here" → no card. |
| M9-25 | M+R | A reply with "@B" → no card; bot or webhook message with mentions → no card. |
| M9-26 | M+R | In #important (policy "QA"), "@B look" → one card: B, C, D; D appears once. |
| M9-27 | M+R | "@D @Dev …"; D loses `@Dev` → D stays (explicit). |
| **M9-28** | M only | **Mentions on, roles off.** "@B" → card for B. "@Dev" only → **no card**. "@B @Dev" → card for **B only**. Intents 3585; `/autotrack` says disabled. |
| **M9-29** | M+R | **Paused** (block REST as in M9-14): "@B @E" (no policy in #general) → **card created, no pause notice**. "@B @Dev" → **no card**. In #important (has a policy), "@B" → **no card**. |
| **M9-30** | M+R | **Edit after tracking starts:** edit "@B check" → "@E check" → targets stay B; E is not added; B's ack stays. Editing an untracked message to add "@B" → no card. |
| **M9-31** | M+R | **Thread / forum:** "@B" in the public thread under #important → card with **B only**; the #important policy's roles are **not** added. A forum post starter with "@E" → card for E. A thread message with no mentions → no card. |
| **M9-32** | M+R | **Forward:** forward a message that contained "@Dev @C" into #general → **no** targets from the snapshot (no card, unless the forwarder adds their own outer mention). Record whether the outer `mentions` is empty or copied (§0.2 #10). In #important, the forward triggers via the policy with policy targets only. |
| **M9-33** | M+R | ⚠ Record: `mention_roles` for a non-mentionable role mentioned without permission; `channel_type` presence (text, thread, forum post); the forward's outer `type`, `message_reference.type` and `HAS_SNAPSHOT` flag. |
| **M9-34** | M+R | **Explicit target leaves:** in the M9-22 card, E leaves the guild → E **remains** a target. In an "@QA" card, C leaves → C removed. |
| **M9-35** | M+R | **Ack authorization after all of the above:** the author clicks their own auto card → rejected. A roles-off-ignored `@Dev` user (M9-28) → rejected. The edited-in E (M9-30) → rejected. Snapshot users (M9-32) → rejected. The thread target B (M9-31) → accepted. A parent-policy-only user in the thread → rejected. A dynamically added `@QA` member → accepted on the existing card. A removed member → rejected, not restored. |
| M9-36 | R only | Mentions off, roles on: "@B" in #general → no card; a plain message in #important → policy card. |
| M9-37 | both off | No auto cards at all; intents 3585; M8 behaviour. |
| M9-38 | — | Manual Track Seen: current target confirms, non-target rejected, role/policy changes never alter it. |

## 19. Documentation updates (during implementation)
- **README:**
  - flag/intent matrix (§14.1), limit, Server Members intent (4014)
  - trigger rules; E4 scope with the D4 policy scope; no inheritance
  - `@everyone` / `@here` excluded; union semantics; fixed vs dynamic sources
  - edit freeze (E1); forward rule (E5); explicit user who leaves (E6)
  - policy states; pause and notice; stop reasons
  - acknowledgement authorization; `/autotrack`
  - M8 → M9 gate
- **`.env.example`:** the three variables.
- **PRIVACY.md:** §15.
- **Manual checklist:** §18.
- **Recovery notes:** member-snapshot recovery vs the message watermark; the pause is runtime-only.

---

## 20. Decisions
All decisions are approved (§3.2). None are open.

**Blockers:** only the M8 baseline, which gates implementation.

Unverified Discord payload details are tracked in §0.2 and checked live (M9-18/19/33). Each is handled fail-closed, or doesn't affect correctness.

---

## 21. Self-review (rev 5): whole-spec consistency

**Flags and intents**
- [x] **`MENTION_AUTO_TRACK_ENABLED` × `ROLE_TARGETS_ENABLED`.**
  - One matrix (§14.1) and one source-collection rule (§8.1 flag filtering, §7.2 write rules).
  - Roles off ⇒ role mentions ignored, never stored, and never revived later (E1).
  - Mentions off ⇒ no message-derived sources, including in policy channels.
- [x] **Gateway intents.** 3585 unless roles are on (3587). The MENTION flag never changes intents. Presence and Message Content are never requested (mention data verified available without them).

**Sources**
- [x] **ExplicitUser.** Fixed; never reads member state (E2, E6); never removed by role changes, pause, or member leave.
- [x] **MentionedRole.** Needs both flags. The reference is frozen (E1) and pruned only by D9. Membership is dynamic through the same index.
- [x] **ChannelPolicy role.** Needs the ROLE flag. Exact text/announcement channels only; never applied to threads or forum posts (D4, §6.1, §8.1, §8.3).

**Pause, edits, forwards, scope**
- [x] **Role-state pause.**
  - Gates only role-dependent work (single definition, §14.2).
  - Explicit-only candidates are created (E2); explicit-only cards show no notice.
  - Mixed candidates fail closed; there are never partial trackings.
- [x] **`MESSAGE_UPDATE`.** Consumed by no auto path; sources frozen; no retroactive creation. The ack table covers edited-in users.
- [x] **Forwarded messages.**
  - Snapshot mentions are never sources.
  - Outer forwarder mentions count.
  - Ambiguous overlap fails closed.
  - A forward still triggers policies (D10).
- [x] **Thread/forum scope.** Mention scope = manual `SUPPORTED_CHANNEL_TYPES`. Missing `channel_type` fails closed with no REST lookup. Policies never inherit.

**Lifecycle and limits**
- [x] **Target limit.** Counted after the union of the sources the current flags allow; no truncation; applied at every creation, reconcile, and policy check.
- [x] **D2.** Unchanged; applies only to role-qualified users; ack and weak evidence never return.
- [x] **Role deletion.** Prunes policy and message sources live and at rebuild; explicit users survive; zero targets → D7.
- [x] **`no_eligible_targets`.** Destructive; unreachable while any explicit source exists; never revived.
- [x] **`feature_disabled`.**
  - The target-based role-dependence definition (§14.2) fixes the rev-4 flaw where explicit-only trackings in a policy channel would have been stopped.
  - Mixed trackings stop whole.
  - History is kept; manual trackings are never selected.
- [x] **`target_limit_exceeded`.** The stop happens before any diff; history is kept; never reconciled.

**Access and isolation**
- [x] **Ack authorization.** A single transactional check on persisted target rows. All the new scenarios are enumerated (§12.6) and tested (A13, M9-35). No per-viewer visibility.
- [x] **Manual isolation.** Every dynamic path filters `origin='auto'`. Manual stores no sources and keeps its scope, cap, and picker, plus the same acknowledgement rule.

**Recovery and gating**
- [x] **Startup / fresh READY.**
  - Health `awaiting_guild` → `GUILD_CREATE` rebuild (policy ∪ message roles) → reconcile → healthy → refresh.
  - With roles off: no health; the D6 sweep runs before the gateway.
  - Explicit-only creation doesn't wait for health.
- [x] **RESUMED.** Nothing: no rebuild and no health change. The message watermark is untouched.
- [x] **M8 gate.** Top of the spec, §14.4, §18 preconditions, §20.
- [x] **Checklist coverage of the 12 required scenarios.**

  | # | Scenario | Tests / checklist |
  |---|---|---|
  | 1 | Mentions on, roles off, `@user` | M14a / M9-28 |
  | 2 | Mentions on, roles off, `@role` only | M14b / M9-28 |
  | 3 | Mentions on, roles off, `@user` + `@role` | M14c / M9-28 |
  | 4 | Paused, explicit-only | M15a / M9-29 |
  | 5 | Paused, explicit + role | M15b / M9-29 |
  | 6 | Edit after tracking starts | #40a / M9-30 |
  | 7 | Mention in a thread or forum post | M19 / M9-31 |
  | 8 | No parent-policy inheritance | M20 / M9-31 |
  | 9 | Snapshot mentions ignored | M21 / M9-32 |
  | 10 | Outer forwarder mentions kept | M22 / M9-32 |
  | 11 | Explicit target leaves | M23 / M9-34 |
  | 12 | Ack authorization after all of these | A13 / M9-35 |
