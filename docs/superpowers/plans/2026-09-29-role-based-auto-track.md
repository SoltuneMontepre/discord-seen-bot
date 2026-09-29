# Role-based Auto Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

> **Canonical location after approval:** `docs/superpowers/plans/2026-09-29-role-based-auto-track.md`. Plan mode lets me write only to this scratch file; the content is saved unchanged to that path once approved. The earlier M0–M7 plan that lived in this scratch file is superseded; it is implemented in commit `8136a65`, with the research in `~/.claude/plans/buzzing-seeking-crown.md`.

> **Task 0 gate record (M8): PASS.** 2026-09-30, baseline commit `8136a65`.
> - Every M8 checklist item was run live and confirmed passed by the project owner. No regressions, so no fix commits.
> - Local re-verification: `pnpm check` ✅ (20 files / 231 tests); `pnpm test:coverage` ✅ (90.33 / 80.34 / 91.19 / 94.01 %).
> - Recorded in `docs/manual-checklist.md` › M8 gate record.

> **Execution rulings** (smallest deviations recorded during implementation; spec unchanged):
> 1. *Task 4:* the three new stop-line strings land in Task 4, not Task 16, because the exhaustive `stopLine()` switch must compile once `StopReason` grows.
> 2. *Task 5:* `TrackedMessage.origin` / `channelType` are added with the schema in Task 5 (the row mapper needs them), not in Task 6.
> 3. *Task 5:* Kysely 0.29's `SqliteAdapter.supportsTransactionalDdl` is `false`, so the Migrator does **not** wrap migrations in a transaction (the plan's "migrator's single transaction" premise is wrong). Migration 0002 opens its own `db.transaction()` around every statement including the in-migration `foreign_key_check`, and carries a re-entry guard (schema already migrated ⇒ no-op) for a crash between its commit and Kysely recording the row. FK pragma handling in `migrateToLatest()` is unchanged.
> 4. *Task 10:* `reconcileInQueue` / `reconcileChannelInQueue` / `reconcileGuildInQueue` take an optional `{ ignorePause }`. Only the rebuilder's recovery reconcile passes it: spec §9.2 step 4 runs `reconcileGuild()` while the state is `reconciling`, which is paused, so without it the recovery reconcile would skip every role-dependent tracking.
> 5. *Task 10:* `GuildQueue` also rejects cross-guild cycles (1 → 2 → 1) via the ownership chain. Timers and continuations that outlive a task are not "inside" it, so retry timers may enqueue. The app layer stays free of Discord imports (channel types 0/5 as commented literals).
> 6. *Task 14:* the coordinator also depends on `index` + `rebuilder` (role flag on). A mentioned role that is not yet referenced grows the referenced-role set, which spec §9.2 lists as a rebuild trigger, and M2 requires its members. Phase A therefore calls `rebuildNowInQueue(g, "roles_grew", { extraReferencedRoleIds, reconcile: false })` in-queue, like PolicyService, before resolving. A failed extension fails closed. A `roles_grew` completion is logged at debug and triggers no resume refresh. `publishAutoCompanion` returns `{ status, error? }` so the coordinator can rate-limit the per-channel warning.
> 7. *Task 18:* spec §12.3 still lists "At most 25 policies per channel", but the owner's plan review (round 1) explicitly removed that limit, and the approved plan's Global Constraint 13 records it. The later explicit owner decision wins: there is no policy-count limit, and `/autotrack list` paginates. `PolicyResult` gains `invalid_name` (1–100 characters, §12.3). A tracking whose last policy source disappears while paused has no role source left, so it is not role-dependent (§14.2), and D7 applies immediately instead of at recovery (§6.2 step 1).
> 8. *Task 19:* the state button encodes its intent (`ap-enable` / `ap-disable` / `ap-keep`) instead of a single `ap-state`, so a stale panel can never toggle the wrong way. `Responder` gains `showModal` (MODAL response) for Rename; the modal uses a Label-wrapped text input (action rows in modals are deprecated). `/autotrack list` defaults to the invocation channel, and create fails closed when the selected channel's resolved data is missing or has an unsupported type.
> 9. *Task 20:* lifecycle cleanup uses a separate `TrackingService.lifecycle` field, not an extension of `hooks`, so the existing `hooks` assignments are unchanged. `createBot` derives and asserts the intents itself (`buildIntents` + `assertAllowedIntents`) and passes them to `createGateway(intents)`, which makes the intents given to the gateway factory testable. `main.ts` passes a factory taking that argument. `Sweeper` gains an `afterTick` callback for the per-guild referenced-role prune.

**Goal:** Implement M9, automatic tracking driven by channel role policies and message mentions, without regressing existing manual *Apps → Track Seen* behaviour.

**Architecture.**
- **Pipeline:** every auto tracking runs through one pipeline:
  1. **Target sources.** Explicit users and mentioned roles are frozen in `tracking_sources`; channel-policy roles are read live from the policy tables.
  2. **`TargetResolverRegistry`.** The explicit-user resolver needs no member state; the role resolver reads an in-memory `MemberRoleIndex`.
  3. **Desired set.** Union, dedupe, remove the author, remove bots, then check the D8 limit.
  4. **`TargetReconciler`.** One SQLite transaction, which is the only place targets are added or removed.
  5. Result: `tracking_targets` → the existing status card via `RenderScheduler` (global edit cap 2).
- **Role state:** one shared subsystem per guild:
  - a runtime health machine (`awaiting_guild | rebuilding | reconciling | failed | unavailable | healthy`)
  - REST snapshot rebuilds on `GUILD_CREATE`
  - live member/role events
  - a per-guild ordered queue
- **Flags:** two independent flags, `MENTION_AUTO_TRACK_ENABLED` and `ROLE_TARGETS_ENABLED`, both off by default, which reproduces M0–M7 exactly. Only `ROLE_TARGETS_ENABLED` adds `GUILD_MEMBERS` (intents 3585 → 3587). Message Content and Presence are never requested.
- **Acknowledgement:** authorized at click time inside the existing transactional `repo.acknowledge()`. Only current persisted targets can confirm.

**Tech Stack:**
- TypeScript on Node ≥24.12, native type stripping, no build step
- `@discordjs/core` ^2.6, `@discordjs/rest` ^2.6.3, `@discordjs/ws` ^2.0.4
- SQLite via `better-sqlite3` ^13 + `kysely` ^0.29 (static-provider `Migrator`)
- `zod` ^4, `pino` ^10, `p-limit` ^7
- Vitest ^5 (+ `@vitest/coverage-v8`), Biome ^2.5, pnpm 12
- Docker/Podman image `node:24-slim`

**Spec:** `docs/superpowers/specs/2026-09-29-role-based-auto-track-design.md` (rev 5, approved). Section numbers `§x` in this plan refer to it.

---

## Global Constraints

1. **M8 gate (hard).** Task 0 must pass before any other task. If it doesn't, the executor **stops** and reports. Nothing may be done to "satisfy" the gate artificially.
2. **No product decisions.** Every behaviour comes from the spec. If a genuine contradiction turns up, stop and ask; don't invent.
3. **TDD for every behaviour task.** Order: failing test → run the narrow test and see the expected failure → minimal code → narrow test passes → surrounding suite → commit checkpoint.
4. **Never weaken existing tests.** All 231 existing tests stay green. Change an existing test only where a type gains a field (e.g. `origin`), and say so in the commit message.
5. **Coverage floor.** Task 1 locks the current baseline into `vitest.config.ts` (statements ≥ 90, branches ≥ 80, lines ≥ 94). Thresholds may only go up.
6. **Intents and content.**
   - Never request `MESSAGE_CONTENT` or `GUILD_PRESENCES`.
   - Request `GUILD_MEMBERS` only when `ROLE_TARGETS_ENABLED=true`.
   - Never read or store message textual content: `content`, `embeds`, `attachments`, or snapshot `content`/`embeds`/`attachments`.
   - **Snapshot mention ids (E5).** Forward snapshots' `mentions[].id` and `mention_roles[]` may be **inspected only** to detect outer/snapshot overlap. They are never Target Sources, and the temporary id sets are discarded once the candidate is built. Nothing from a snapshot is persisted.
   - Keep: snapshot-only mention → not a source; outer-only mention → source; outer+snapshot overlap → that id is dropped (fail closed).
7. **Manual isolation.** Every dynamic path filters `origin = 'auto'`. The manual Track Seen start path, the 25-target cap, the picker, Manage editing and `checkExisting` all stay behaviourally unchanged.
8. **No pings.** Every create, edit and update keeps `allowed_mentions: { parse: [] }`. The card never renders role mentions.
9. **Privacy.**
   - Persist ids and timestamps only.
   - Never persist a member directory or availability history.
   - Keep the 7-day expiry / 30-day purge.
10. **Style.**
    - Match the existing code style: no parameter properties (`erasableSyntaxOnly`), `.ts` import suffixes, Biome formatting.
    - Run `pnpm format` before each commit.
    - Don't clean up unrelated code.
11. **Commits.**
    - One commit per task, using the message given in the task.
    - The repository has no commit-attribution policy (checked: history, config, docs), so the plan imposes none.
    - **Never push.**
12. **No nested guild-queue execution.**
    - Methods suffixed `…InQueue` assume the caller already owns that guild's `GuildQueue` slot. They must never call `queue.run`/`queue.runKeyed` for the same guild.
    - `GuildQueue` enforces this: a same-guild `run`/`runKeyed` from inside a running task throws `NestedGuildQueueError` (detected via `AsyncLocalStorage`) instead of deadlocking.
13. **No unapproved product limits.** The only limits are the ones the spec approves: D8 (`AUTO_TRACK_MAX_TARGETS`) and the manual 25 cap. Discord component limits (e.g. 25 select options) are handled by pagination, never by new product rules.
14. **Live-only behaviour.** Anything that can only be confirmed on Discord stays labelled **manual/unverified** until the M9 checklist (Task 23) has been run by a human.

## Review Focus (what reviewers must scrutinise)

- **Migration 0002 (Task 5).**
  - Foreign keys are turned off **outside** the transaction.
  - `foreign_key_check` runs **inside** the migration, so a failure rolls back.
  - `sqlite_sequence` is preserved.
  - Child rows survive.
  - Existing rows get `origin='manual'`.
- **The single destructive path (Task 10).** `reconcileAutoTargets` must:
  - select only rows with `stopped_at IS NULL AND origin='auto'`
  - check the D8 limit **before** any diff
  - delete all targets **before** stopping with `no_eligible_targets`
- **Role-dependence (Task 10, §14.2).** One definition, used by the pause gate, the pause notice and the D6 sweep.
- **Fail-closed paths.**
  - A paused guild never mutates role-derived targets.
  - A missing `channel_type` produces no candidate.
  - Ambiguous forward mentions are dropped.
- **Ordering (Tasks 9, 12, 14).** Member events queue behind rebuilds. Phase A runs inside the guild queue and phase B outside it.
- **No nested queue calls (Tasks 10, 12, 15, 18).** Only `rebuilder.requestRebuild`, `coordinator.onMemberEvent` / `onTopLevelMessage` and `PolicyService` mutations enqueue. Everything called from inside a task is an `…InQueue` method or a plain DB transaction. The `NestedGuildQueueError` guard tests must pass.
- **Atomic role deletion (Task 7b).** `RoleDeletionStore.apply()` is a single transaction; trigger-injected failure rolls everything back.
- **Lossless keyed coalescing (Task 10).** A key dirtied while its task runs gets exactly one trailing rerun.
- **Lifecycle cleanup (Task 20).** `CHANNEL_DELETE` → the channel's policies are deleted; `GUILD_REMOVED` → the guild's policies are purged. Both run regardless of flags.
- **R12 (Task 17).** A rejected acknowledgement causes zero writes and zero renders.
- **Flag matrix (Tasks 2, 3, 20).** With both flags off, behaviour is exactly M0–M7.
- **Render load (Task 16).** At most 2 edits are in flight. The pause notice arrives only after the 60 s grace. Resume coalesces updates.

---

## File structure map

### A. Created (product)
| File | Responsibility |
|---|---|
| `src/domain/target-sources.ts` | `TargetSource`, `AutoTrackCandidate`, `MemberStateEvent` types (pure) |
| `src/domain/policy-state.ts` | Policy state machine `nextPolicyState()` (pure) |
| `src/app/target-resolution.ts` | `TargetSourceResolver`, `TargetResolverRegistry` |
| `src/app/explicit-user-resolver.ts` | Static resolver (no member state) |
| `src/app/role-source-resolver.ts` | Role resolver over `MemberRoleIndex` |
| `src/app/member-role-index.ts` | In-memory referenced-role → members map, plus bot flags |
| `src/app/guild-auto-track-health.ts` | Runtime health per guild, pause, grace-period timers |
| `src/app/guild-queue.ts` | Per-guild ordered task queue with coalescing |
| `src/app/role-dependence.ts` | `isRoleDependent()` (roles on) and `isRoleDependentWhenRolesOff()` (§14.2) |
| `src/app/target-reconciler.ts` | Desired set → limit → one-transaction diff → hand-off |
| `src/app/backfill-queue.ts` | `p-limit(2)` coalesced `backfillTargets` |
| `src/app/member-state-rebuilder.ts` | `requestRebuild` (external) / `rebuildNowInQueue` (in-queue): roles prune + member pagination + `reconcileGuildInQueue` + backoff |
| `src/app/auto-track-coordinator.ts` | Entry point for every M9 event and mutation (phases A/B, member events, policy changes) |
| `src/app/config-authorizer.ts` | Single configuration authorization boundary |
| `src/app/policy-service.ts` | Policy CRUD, validation, limit and pause rules |
| `src/db/migrations/0002_auto_track.ts` | Rebuild of `tracked_messages`; `tracking_sources`; policy tables; indexes |
| `src/db/policy-repository.ts` | Policy persistence |
| `src/db/role-deletion.ts` | `RoleDeletionStore.apply()`: the single transaction for role deletion (policy sources + state transitions + `tracking_sources`) |
| `src/discord/adapters/member.ts` | Member, role-delete and guild-create/delete → domain events |
| `src/discord/interactions/config/autotrack.ts` | `/autotrack create`/`list` handlers |
| `src/discord/interactions/config/policy-panel.ts` | Policy panel components and modal |

### B. Modified (product)
- **Configuration:** `src/config.ts`, `src/domain/policy.ts`, `src/domain/types.ts`
- **Database:** `src/db/schema.ts`, `src/db/migrator.ts`, `src/db/repository.ts`
- **App layer:** `src/app/ports.ts`, `src/app/render-scheduler.ts`, `src/app/tracking-service.ts`, `src/app/startup-recovery.ts`
- **Discord layer:**
  - `src/discord/intents.ts`, `src/discord/gateway.ts`, `src/discord/adapters/message.ts`, `src/discord/discord-port.ts`, `src/discord/commands.ts`, `src/discord/custom-id.ts`
  - `src/discord/interactions/router.ts`, `src/discord/interactions/buttons.ts`
  - `src/discord/render/card.ts`, `src/discord/render/text.ts`
- **Composition:** `src/bot.ts`, `src/main.ts`
- **Not modified** (existing behaviour already sufficient):
  - `scripts/register-commands.ts` — it already calls `commandsFor()`, which gains `/autotrack`
  - `scripts/forget-user.ts` — it calls the extended `repo.forgetUser`
  - `src/domain/eligibility.ts` — the cap is already a parameter; auto tracking passes `Number.POSITIVE_INFINITY`

### C. Test infrastructure and docs
- **Modified test infrastructure:** `vitest.config.ts` (coverage floor), `test/helpers/fake-discord.ts`, `test/helpers/app.ts`, `test/helpers/interactions.ts`, `test/fixtures/gateway.ts`
- **New tests:** `test/unit/{intents,policy-state,target-resolution,member-role-index,guild-health,guild-queue,role-dependence,adapters-auto-track,commands}.test.ts` and `test/integration/{migration-0002,repository-auto,policy-repository,role-deletion,target-reconciler,member-recovery,auto-track,mention-auto-track,message-update,member-events,target-limit,ack-authorization,policy-service,config-interactions,feature-flags,lifecycle-cleanup}.test.ts`
- **Docs:** `README.md`, `PRIVACY.md`, `.env.example`, `docs/manual-checklist.md`

---

## Tasks

Task order follows the dependency graph. Each task ends green (`pnpm check`) and is independently reviewable.

- **Narrow test command:** `pnpm vitest run <file>`
- **Surrounding suite:** `pnpm test`
- **Before each commit:** `pnpm format && pnpm check`

### Task 0 — M8 baseline gate (HUMAN + VERIFY; no code)
**Deliverable:** a recorded gate result: either "PASS at commit `<sha>`" or a STOP report.

1. Read `docs/manual-checklist.md`. **All** rows, including every ⚠ row and 22b/23/24, must have a recorded PASS with a date.
2. Confirm that every regression M8 found has a fix commit and a regression test (`git log --oneline 8136a65..HEAD`).
3. On `HEAD`, run `pnpm check` and `pnpm test:coverage`. Both must pass.
4. Ask the human to confirm the re-verification run: the M8 checklist executed again after the fixes.
5. Record the result as a short block at the top of this plan: date, commit sha, and who confirmed.
6. **If any step fails: STOP.** Report what is missing and do **not** start Task 1.

### Task 1 — Lock the coverage floor
**Files:** `vitest.config.ts`
1. Run `pnpm test:coverage` and record the actual numbers.
2. Add `coverage.thresholds: { statements: 90, branches: 80, lines: 94 }`, or the measured floor if that is higher (rounded down).
3. Run `pnpm test:coverage`: it must pass. Temporarily set `lines: 99` and confirm it fails, then revert to the recorded value.

Commit: `test: enforce coverage floor before M9`

### Task 2 — Configuration: feature flags and limit
**Files:**
- modify `src/config.ts`, `src/domain/policy.ts`, `test/unit/config.test.ts`, `.env.example`
- add the vars to `test/helpers` config as needed

**Interfaces:**
- `Config` gains `features: { mentionAutoTrack: boolean; roleTargets: boolean }`.
- `Policy` gains:
  - `autoTrackMaxTargets: number` (default 100, env-overridable)
  - `pauseNoticeGraceMs: 60_000`
  - `renderEditConcurrency: 2`
  - `memberRebuildBackoffMs: [60_000, 300_000, 900_000]`
  - `memberRebuildSteadyMs: 900_000`
  - `reconcileRetryMs: 60_000`
  - `overLimitLogIntervalMs: 600_000`
  - `backfillConcurrency: 2`
- Env: `MENTION_AUTO_TRACK_ENABLED` and `ROLE_TARGETS_ENABLED` (`"true"`/`"false"`, default `"false"`, anything else rejected); `AUTO_TRACK_MAX_TARGETS` (an integer 1..500, default 100). Production **also** honours `AUTO_TRACK_MAX_TARGETS`: it is configuration, not a dev override.

**Tests** (in `test/unit/config.test.ts`):
- `defaults: both flags false, autoTrackMaxTargets 100`
- `parses MENTION_AUTO_TRACK_ENABLED=true and ROLE_TARGETS_ENABLED=true independently`
- `rejects flag value "yes"`
- `AUTO_TRACK_MAX_TARGETS=1 and =500 accepted` (boundaries)
- `rejects 0, 501, "abc", "12.5" with an error naming AUTO_TRACK_MAX_TARGETS`
- `existing dev overrides unaffected`

**Steps:** write the tests → `pnpm vitest run test/unit/config.test.ts` (FAIL: unknown fields) → implement the zod schema → PASS → `pnpm test`. Add the three variables, with comments, to `.env.example`.

Commit: `feat(config): M9 feature flags and AUTO_TRACK_MAX_TARGETS`

### Task 3 — Flag-aware gateway intents
**Files:** modify `src/discord/intents.ts`; create `test/unit/intents.test.ts`. Adapt the intent assertions in `test/integration/bot.test.ts` without weakening them.

**Interfaces:**
- `buildIntents(features: { roleTargets: boolean }): number`
- `assertAllowedIntents(intents: number, features: { roleTargets: boolean }): void`
  - throws if `MessageContent` or `GuildPresences` is present
  - throws if `GuildMembers` is present while `roleTargets` is false
- Keep `INTENTS` (the 3585 base) exported for existing callers.

**Tests:**
| Test | Assertion |
|---|---|
| matrix M=false/R=false | 3585 |
| matrix M=true/R=false | 3585 |
| matrix M=false/R=true | 3587 |
| matrix M=true/R=true | 3587 |
| never includes MESSAGE_CONTENT (1<<15) or GUILD_PRESENCES (1<<8) | in all 4 combinations |
| assertAllowedIntents throws for GuildMembers when roleTargets=false | — |
| assertAllowedIntents throws for MessageContent always | — |

The mention flag is not an input to `buildIntents`, by design.

**Steps:** TDD as above.

Commit: `feat(intents): request GUILD_MEMBERS only when role targets enabled`

### Task 4 — Domain types and policy state machine
**Files:**
- create `src/domain/target-sources.ts`, `src/domain/policy-state.ts`, `test/unit/policy-state.test.ts`
- modify `src/domain/types.ts`

**Interfaces:**
```ts
// types.ts
export type TrackingOrigin = "manual" | "auto";
// TrackedMessage gains: origin: TrackingOrigin
// STOP_REASONS gains: "no_eligible_targets" | "feature_disabled" | "target_limit_exceeded"

// target-sources.ts
export type TargetSource = { type: "user"; userId: Snowflake } | { type: "role"; roleId: Snowflake };
export interface AutoTrackCandidate { guildId; channelId; channelType: number; messageId; authorId;
  explicitUserIds: Snowflake[]; mentionedRoleIds: Snowflake[] }
export type MemberStateEvent =
  | { t: "member_upsert"; guildId; userId; roleIds: Snowflake[]; bot: boolean }
  | { t: "member_remove"; guildId; userId }
  | { t: "role_delete"; guildId; roleId }
  | { t: "guild_available"; guildId } | { t: "guild_unavailable"; guildId } | { t: "guild_removed"; guildId };

// policy-state.ts
export type PolicyState = "enabled" | "user_disabled" | "auto_disabled_missing_role";
export type PolicyEvent =
  | { type: "user_disable" } | { type: "keep_disabled" }
  | { type: "user_enable"; sourceCount: number }
  | { type: "roles_saved"; sourceCount: number }     // user edited roles
  | { type: "role_deleted"; sourceCount: number };   // system pruning
export function nextPolicyState(s: PolicyState, e: PolicyEvent):
  { ok: true; state: PolicyState } | { ok: false; reason: "needs_role" | "invalid" };
```

**Tests** (`policy-state.test.ts`), one per row of spec §7.3:

| Test | Result |
|---|---|
| `enabled + user_disable` | `user_disabled` |
| `enabled + role_deleted(1)` | `enabled` |
| `enabled + role_deleted(0)` | `auto_disabled_missing_role` |
| `auto_disabled + roles_saved(1)` | `enabled` |
| `auto_disabled + keep_disabled` | `user_disabled` |
| `user_disabled + roles_saved(2)` | `user_disabled` |
| `user_disabled + role_deleted(0)` | `user_disabled` |
| `user_disabled + user_enable(1)` | `enabled` |
| `user_enable(0)` | `{ok:false, reason:"needs_role"}` |
| `enabled + roles_saved(0)` | `needs_role` |
| `keep_disabled on enabled` | `invalid` |
| property: every ok result with state enabled has sourceCount ≥ 1 | — |

Commit: `feat(domain): TargetSource types and policy state machine`

### Task 5 — Migration 0002 (careful task)
**Files:**
- create `src/db/migrations/0002_auto_track.ts`, `test/integration/migration-0002.test.ts`
- modify `src/db/migrator.ts`, `src/db/schema.ts`
- update the existing fixtures that build `TrackedMessage` so they include `origin: "manual"`

**Design (spec §7.1–7.3):**
- **`migrator.ts`.** Export `MIGRATIONS` (the static record) and `migrateTo(db, name)` for tests. `migrateToLatest()`:
  1. runs `PRAGMA foreign_keys = OFF` **before** creating the `Migrator` (no transaction open, so it takes effect)
  2. runs the migrator
  3. in `finally`, runs `PRAGMA foreign_keys = ON`
  4. then runs `PRAGMA foreign_key_check` and throws if any rows come back
- **`0002.up()`**, inside the migrator's single transaction:
  1. `SELECT seq FROM sqlite_sequence WHERE name='tracked_messages'` (may be absent)
  2. `CREATE TABLE tracked_messages_new (…all existing columns…, origin … CHECK (origin IN ('manual','auto')), channel_type INTEGER NULL, stop_reason CHECK (… 8 values …), CHECK ((stopped_at IS NULL) = (stop_reason IS NULL)))`. The nullable `channel_type` stores the Discord channel type of an auto tracking's source location, so the reconciler can apply D4 (policy roles only for GUILD_TEXT / GUILD_ANNOUNCEMENT) without a REST lookup. Manual and legacy rows stay NULL. This is a persistence-only addition; see the planning finding in the self-review.
  3. `INSERT INTO tracked_messages_new (cols…, origin) SELECT cols…, 'manual' FROM tracked_messages`
  4. `DROP TABLE tracked_messages`; `ALTER TABLE tracked_messages_new RENAME TO tracked_messages`
  5. Recreate the 7 `tracked_messages` indexes by their existing names, plus the 2 new `tracked_messages` indexes `ix_tracked_active_auto` and `ux_tracked_auto_source` (§10)
  6. `DELETE FROM sqlite_sequence WHERE name='tracked_messages'`, then `INSERT` with `seq = max(oldSeq, COALESCE(MAX(id),0))`
  7. Create `tracking_sources` and `ix_tracking_sources_ref`
  8. Create `auto_track_policies` (with `state` CHECK), `auto_track_policy_sources`, `ix_policies_channel_enabled`, `ix_policies_guild`, `ix_policy_sources_ref`
  9. **Run `PRAGMA foreign_key_check` inside the transaction and throw if any rows come back.** A violation then rolls back the whole migration. This goes further than the spec's post-migration check, without changing the design.
- **`schema.ts`:** add `origin` and the three new tables to `Database`.

**Tests** (`migration-0002.test.ts`, all on temp-file DBs via `tempDbPath`):
- `migrates a 0001 database with data`:
  - migrate to `0001_initial`
  - insert 3 tracked rows (one stopped, one with targets, evidence and acks, one active)
  - `migrateToLatest`
  - all rows are present with identical ids and columns, `origin='manual'`
  - target, evidence and ack counts are unchanged
- `foreign keys enforced after migration`: inserting evidence for a non-existent tracking fails. `PRAGMA foreign_keys` returns 1.
- `cascade still works on the rebuilt parent`: deleting a tracked row removes its children.
- `sequence preserved when highest ids were purged`:
  - at 0001, insert ids 1..5, delete 4 and 5 (so seq = 5)
  - migrate
  - the next `insertTracking` id is **6**, not 4
  - an `sb1:ack:4` custom id now resolves to no row (orphan path)
- `re-running migrateToLatest is a no-op`: it returns `[]` and the data is unchanged.
- `violating FK check rolls back 0002`:
  - at 0001 with FKs off, insert an orphan evidence row
  - `migrateToLatest` throws
  - `kysely_migration` shows only 0001 applied
  - `tracked_messages` has **no** `origin` column
- `CHECK constraints`:
  - `origin='other'` is rejected
  - each of the 8 stop reasons is accepted
  - `stop_reason='bogus'` is rejected
  - policy `state='bogus'` is rejected
- `exact index set`: `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'` equals **exactly** this 17-name set (no more, no less):

  | Group | Names |
  |---|---|
  | Recreated on the rebuilt `tracked_messages` (7) | `ux_tracked_active_source`, `ix_tracked_active_channel`, `ix_tracked_parent`, `ix_tracked_status`, `ix_tracked_expires`, `ix_tracked_stopped`, `ix_tracked_guild` |
  | Untouched from 0001 on other tables (4) | `ix_targets_user`, `ix_evidence_reply_msg`, `ix_evidence_user`, `ix_acks_user` |
  | New in 0002 (6) | `ix_tracked_active_auto`, `ux_tracked_auto_source` (tracked_messages); `ix_tracking_sources_ref` (tracking_sources); `ix_policies_channel_enabled`, `ix_policies_guild`, `ix_policy_sources_ref` (policies) |

  The test also checks that each new index's `sql` contains its partial `WHERE` clause (`origin='auto'`, `state='enabled'`).
- `existing rows have channel_type NULL`.
- **Existing suites:** `test/integration/repository.test.ts` and the rest of the suite still pass.

**Steps:** write the tests → FAIL (no 0002) → implement → narrow PASS → `pnpm test` (fix fixtures for `origin` only).

Commit: `feat(db): migration 0002 — origin, tracking_sources, policies (safe rebuild)`

### Task 6 — Repository: auto-tracking primitives
**Files:** modify `src/db/repository.ts`; create `test/integration/repository-auto.test.ts`.

**Interfaces** (the primitives the rest of M9 builds on):
```ts
insertAutoTracking(input: NewTracking, targets: readonly Snowflake[], sources: readonly TargetSource[])
  : Promise<{ ok: true; tracked: TrackedMessage } | { ok: false; reason: "conflict" }>   // one txn; origin='auto'
listTrackingSources(trackedId: number): Promise<TargetSource[]>
listActiveAuto(filter: { guildId?: Snowflake; channelIds?: readonly Snowflake[] }): Promise<TrackedMessage[]>
listActiveAutoIdsByMessageRoles(guildId: Snowflake, roleIds: readonly Snowflake[]): Promise<number[]>  // via ix_tracking_sources_ref
listActiveAutoIdsWithTarget(guildId: Snowflake, userId: Snowflake): Promise<number[]>
activeMessageRoleIds(guildId: Snowflake): Promise<Snowflake[]>   // distinct 'role' tracking_sources of active auto trackings
reconcileAutoTargets(trackedId: number, desired: readonly Snowflake[], at: UnixMs): Promise<
  | { status: "inactive" | "unchanged" }
  | { status: "changed"; added: Snowflake[]; removed: Snowflake[] }
  | { status: "stopped"; removed: Snowflake[] }>                                  // D7 inside the same txn
stopAuto(trackedId: number, reason: StopReason, at: UnixMs): Promise<boolean>   // only active + origin='auto'
```

**Callers** (so every method is used):

| Method | Called by |
|---|---|
| `insertAutoTracking` | `TrackingService.insertAutoTracking` (Task 14) |
| `listTrackingSources` | `TargetReconciler.sourcesFor` (Task 10); the D6 sweep (Task 20) |
| `listActiveAuto` | `reconcileGuildInQueue` / `reconcileChannelInQueue` (Task 10), the pause-notice refresh (Task 16), coordinator member upsert (Task 15), the D6 sweep (no filter, Task 20) |
| `listActiveAutoIdsByMessageRoles` | Coordinator member upsert (Task 15) |
| `listActiveAutoIdsWithTarget` | Coordinator member remove (Task 15) |
| `activeMessageRoleIds` | The rebuilder's referenced-role computation (Task 12); the referenced-role prune (Task 15) |
| `reconcileAutoTargets` | `TargetReconciler` |
| `stopAuto` | `TargetReconciler` (limit); the D6 sweep |

Role-source pruning is **not** here; it lives in the atomic `RoleDeletionStore` (Task 7b).
- `NewTracking` gains `channelType?: number | null`, defaulting to NULL. `insertAutoTracking` stores it. `insertTracking` (manual) sets `origin='manual'` explicitly and leaves `channel_type` NULL, so the manual path is behaviourally unchanged. `TrackedMessage` gains `channelType: number | null`.
- **`forgetUser` stays one transaction** and additionally:
  - deletes `tracking_sources` rows `('user', userId)`
  - rewrites policy actor ids (`auto_track_policies.created_by_user_id / updated_by_user_id / state_changed_by`, `auto_track_policy_sources.added_by_user_id`) to `'0'`

  So `scripts/forget-user.ts` needs no change.
- **Shared private helper** `deleteUsersFromTracking(trx, id, users)` is used by both `replaceTargets` and `reconcileAutoTargets`, so the deletion SQL lives in one place.

**Tests:**
- `insertAutoTracking writes tracking+targets+sources atomically; conflict on active source returns conflict and writes nothing`
- `permanent auto uniqueness: second insertAutoTracking for same source after stopAuto → conflict`
- `manual insertTracking after an auto tracking stopped → allowed (active-only index)`
- `reconcileAutoTargets inactive for stopped row and for origin='manual' row (manual untouched: targets/evidence identical)`
- `reconcileAutoTargets adds with added_at=at and added_by_user_id='0'; removal deletes target+evidence+ack in one txn`
- `reconcileAutoTargets equal set → unchanged, no writes (changes() = 0)`
- `reconcileAutoTargets empty desired → deletes all targets/evidence/acks THEN stop_reason='no_eligible_targets'; zero history rows`
- `stopAuto keeps rows; no-op on manual row`
- `listActiveAutoIdsByMessageRoles returns only active auto trackings of that guild holding any given role source`
- `listActiveAutoIdsWithTarget returns only active auto trackings where the user is a target (manual excluded)`
- `listActiveAuto filters by guild and channelIds; excludes manual and stopped`
- `forgetUser removes tracking_sources user rows and anonymizes policy actor columns in one transaction`

Commit: `feat(db): auto-tracking repository primitives`

### Task 7 — Policy repository
**Files:** create `src/db/policy-repository.ts` and `test/integration/policy-repository.test.ts`.

**Interfaces:**
```ts
export interface AutoTrackPolicy { id: number; guildId; channelId; name: string; state: PolicyState;
  roleIds: Snowflake[]; stateChangedAt; stateChangedBy; createdAt; createdByUserId; updatedAt; updatedByUserId }
class PolicyRepository {
  create(p: { guildId; channelId; name; roleIds: Snowflake[]; actor; at }): Promise<AutoTrackPolicy>
  get(id: number): Promise<AutoTrackPolicy | undefined>
  listForChannel(channelId, page: { offset: number; limit: number }): Promise<AutoTrackPolicy[]>  // ordered by id
  countForChannel(channelId): Promise<number>
  enabledRoleIdsForChannel(channelId): Promise<Snowflake[]>          // state='enabled' only, deduped
  enabledChannelIdsForRoles(guildId, roleIds: readonly Snowflake[]): Promise<Snowflake[]>  // via ix_policy_sources_ref
  referencedRoleIds(guildId): Promise<Snowflake[]>                    // enabled policies
  saveRolesAndState(id, roleIds, state: PolicyState, actor, at): Promise<void>   // one txn
  setState(id, state, actor, at): Promise<void>
  rename(id, name, actor, at): Promise<void>
  delete(id): Promise<void>
  deleteChannelPolicies(channelId): Promise<number>
  purgeGuild(guildId): Promise<number>
}
```

**Callers:**

| Method | Called by |
|---|---|
| `create`, `get`, `saveRolesAndState`, `setState`, `rename`, `delete` | `PolicyService` (Task 18) |
| `listForChannel`, `countForChannel` | `/autotrack list` pagination (Task 19) |
| `enabledRoleIdsForChannel` | `TargetReconciler.sourcesFor`, phase A, the policy limit check |
| `enabledChannelIdsForRoles` | Coordinator member upsert |
| `referencedRoleIds` | Rebuilder |
| `deleteChannelPolicies`, `purgeGuild` | The lifecycle hooks (Task 20) |

Role pruning is intentionally **not** here (Task 7b), and actor anonymization lives in `repo.forgetUser` (Task 6).

**Tests:**
- `create persists roles; multiple policies per channel; multiple roles per policy`
- `enabledRoleIdsForChannel returns union of enabled policies only and dedupes`
- `user_disabled and auto_disabled policies excluded`
- `enabledChannelIdsForRoles returns channels whose enabled policies contain any role`
- `listForChannel paginates by id (30 policies: offset 0 limit 10 → ids 1–10; offset 20 → 21–30); countForChannel = 30`
- `deleteChannelPolicies deletes only that channel's policies + sources; other channels intact`
- `purgeGuild deletes only that guild's policies + sources`

Commit: `feat(db): auto-track policy repository`

### Task 7b — Atomic role deletion store
**Files:** create `src/db/role-deletion.ts`, `test/integration/role-deletion.test.ts`.

**Interface** (one transaction; the only role-pruning path, used for both live `GUILD_ROLE_DELETE` and offline pruning during rebuild):
```ts
export interface RoleDeletionResult {
  affectedPolicyIds: number[]; autoDisabledPolicyIds: number[];
  affectedChannelIds: Snowflake[]; affectedTrackingIds: number[] }
class RoleDeletionStore {
  constructor(db: Kysely<Database>)
  apply(guildId: Snowflake, roleId: Snowflake, at: UnixMs): Promise<RoleDeletionResult>
}
```

**Inside one `db.transaction()`:**
1. Select the guild's policies that have `('role', roleId)`, then delete those `auto_track_policy_sources` rows.
2. For each affected policy:
   - count the remaining sources
   - compute `nextPolicyState(state, { type: "role_deleted", sourceCount })`
   - if the state changes, update `state`, `state_changed_at = at`, `state_changed_by = '0'`, `updated_at`, `updated_by_user_id = '0'`

   This keeps `user_disabled` as `user_disabled`. An `enabled` policy with zero sources left becomes `auto_disabled_missing_role`.
3. Delete `tracking_sources` rows `('role', roleId)` belonging to active auto trackings of the guild, `RETURNING tracked_message_id`.
4. Return the ids for **post-commit** reconciliation. Reconciliation is never done inside this transaction.

**Tests:**
- `enabled policy losing its only role → auto_disabled_missing_role, state_changed_by '0'`
- `enabled policy with another role left → stays enabled`
- `user_disabled policy losing its last role → stays user_disabled`
- `tracking_sources role rows of that guild deleted; other guild's identical role id untouched; stopped trackings untouched`
- `returns affected policy/channel/tracking ids`
- `idempotent: second apply → empty result, no writes`
- **`injected failure rolls back everything`:**
  - create the trigger `CREATE TRIGGER fail_ts BEFORE DELETE ON tracking_sources BEGIN SELECT RAISE(ABORT,'boom'); END`, so step 3 fails **after** steps 1–2 already ran
  - `apply` rejects
  - policy source rows are unchanged, policy `state` values are unchanged, `tracking_sources` rows are unchanged
  - drop the trigger, re-apply, and it succeeds

Commit: `feat(db): atomic role-deletion transaction`

### Task 8 — Target resolution: registry and explicit-user resolver
**Files:** create `src/app/target-resolution.ts`, `src/app/explicit-user-resolver.ts`, `test/unit/target-resolution.test.ts`.

**Interfaces:**
```ts
export interface ResolveContext { guildId: Snowflake }
export interface ResolvedTarget { userId: Snowflake; bot: boolean | undefined }
export interface TargetSourceResolver<S extends TargetSource = TargetSource> {
  readonly type: S["type"]; readonly requiresMemberState: boolean;
  resolve(source: S, ctx: ResolveContext): ResolvedTarget[];
}
export class TargetResolverRegistry {
  register(r: TargetSourceResolver): void
  requiresMemberState(sources: readonly TargetSource[]): boolean
  desiredTargets(sources: readonly TargetSource[], ctx: ResolveContext & { sourceAuthorId: Snowflake }): Snowflake[]
}
```
- `desiredTargets` uses `eligibleTargets(candidates, author, Number.POSITIVE_INFINITY)`, so it **never truncates**.
- An unknown source type throws.
- `ExplicitUserResolver.requiresMemberState` is `false`, and `resolve` returns `[{userId, bot:false}]`. It has **no** dependency on `MemberRoleIndex`, which a test asserts.

**Tests:**
- `duplicate explicit users → once`
- `author among explicit users → excluded`
- `requiresMemberState false for only user sources, true when any role source present`
- `unknown source type throws`
- `returns full set above 100 (no truncation; limit is caller's job)`
- Role cases are added to this file in Task 9.

Commit: `feat(app): target source registry and explicit-user resolver`

### Task 9 — Member role index and role resolver
**Files:** create `src/app/member-role-index.ts`, `src/app/role-source-resolver.ts`, `test/unit/member-role-index.test.ts`; extend `test/unit/target-resolution.test.ts`.

**Interfaces:**
```ts
class MemberRoleIndex {
  /**
   * Replaces the referenced-role set with a value computed from source of truth.
   * SHRINK: roles no longer referenced are discarded from every member; members left with no referenced
   *         role are deleted. GROW: new roles start with NO members. Only a rebuild snapshot may populate
   *         them (never fabricate membership).
   */
  setReferencedRoles(guildId, roleIds: Iterable<Snowflake>): { droppedRoleIds: Snowflake[]; addedRoleIds: Snowflake[] }
  referencedRoles(guildId): ReadonlySet<Snowflake>
  replaceSnapshot(guildId, members: { userId; roleIds: Snowflake[]; bot: boolean }[]): void // keeps referenced only
  upsert(guildId, userId, roleIds: Snowflake[], bot: boolean): { changedRoleIds: Snowflake[] }  // old Δ new, referenced
  remove(guildId, userId): { hadRoleIds: Snowflake[] }
  dropRole(guildId, roleId): void
  membersOf(guildId, roleId): ResolvedTarget[]
  clear(guildId): void
}
```
`RoleSourceResolver` has `requiresMemberState = true` and resolves through `membersOf`.

**Tests:**
- `snapshot keeps only members holding referenced roles` (privacy: a member with no referenced role isn't stored)
- `upsert returns changedRoleIds only for referenced roles`; `nickname-only update (same roles) → []`
- `upsert twice identical → second returns []` (idempotent)
- `remove returns previous roles`
- `dropRole removes role from all members`
- **`setReferencedRoles shrink discards obsolete membership`**: members of `@Old` are no longer returned by `membersOf(@Old)`; a member holding only `@Old` is removed from the index entirely (internal size shrinks); members also holding a still-referenced role keep it.
- `setReferencedRoles grow adds the role with zero members (no fabricated membership) and reports addedRoleIds`
- `events applied after replaceSnapshot win` (ordering: snapshot has Binh in @Dev, then upsert removes it → not member)
- **Registry with roles:** one role → members; two roles → union; the same user through two roles → once; explicit + role overlap → once; bot in role → excluded; author holding the role → excluded.

Commit: `feat(app): in-memory member role index and role resolver`

### Task 10 — Guild queue, health, role-dependence, target reconciler
**Files:** create `src/app/guild-queue.ts`, `src/app/guild-auto-track-health.ts`, `src/app/role-dependence.ts`, `src/app/target-reconciler.ts`, `src/app/backfill-queue.ts`, and the tests `unit/guild-queue`, `unit/guild-health`, `unit/role-dependence`, `integration/target-reconciler`.

**Interfaces:**
```ts
class NestedGuildQueueError extends Error {}
class GuildQueue {
  /** FIFO per guild. Throws NestedGuildQueueError if called from inside a running task of the SAME guild. */
  run<T>(guildId, task: () => Promise<T>): Promise<T>
  /**
   * Lossless keyed scheduling (e.g. key "rebuild", "reconcile:channel:<id>"):
   * - not pending and not running → enqueue
   * - pending (not started) → merge into the pending run (same promise)
   * - running → mark dirty; exactly ONE trailing rerun is enqueued after it finishes
   * The task must recompute from source of truth, so a rerun never needs arguments from the dirtying call.
   * Same nested-call guard as run().
   */
  runKeyed(guildId, key: string, task: () => Promise<void>): Promise<void>
  /** Assertion helper for …InQueue methods; throws unless the current async context owns guildId. */
  assertInQueue(guildId): void
}
type GuildHealthState = "awaiting_guild" | "rebuilding" | "reconciling" | "failed" | "unavailable" | "healthy";
class GuildAutoTrackHealth {
  constructor(deps: { clock; policy; onPauseNoticeDue(guildId): void; logger })
  state(g): GuildHealthState; isPaused(g): boolean;          // unknown guild → awaiting_guild (paused)
  set(g, s: GuildHealthState, detail?: { reason?; code?; attempt?; nextRetryInMs? }): void
  resetAll(): void                                            // READY
  forget(g): void; dispose(): void
}
// role-dependence.ts (§14.2 — the only definition)
export function isRoleDependent(sources: readonly TargetSource[]): boolean               // ROLE on
export function isRoleDependentWhenRolesOff(trackingSources: readonly TargetSource[],
                                            targetUserIds: readonly Snowflake[]): boolean // ROLE off
class TargetReconciler {       // all mutating methods require the caller to own the guild queue
  sourcesFor(t: TrackedMessage): Promise<TargetSource[]>     // read-only; tracking_sources ∪ live enabled policy roles if ROLE on ∧ channel text/announcement
  reconcileInQueue(trackedId): Promise<"skipped_paused" | "inactive" | "unchanged" | "changed" | "stopped" | "limit_stopped">
  reconcileChannelInQueue(guildId, channelId): Promise<void>
  reconcileGuildInQueue(guildId): Promise<void>
}
class BackfillQueue { enqueue(trackedId: number, userIds: readonly Snowflake[]): void; dispose(): void }
```

**Rules implemented:**
- The reconciler **skips** a tracking when `isRoleDependent(sources)` and `health.isPaused(guild)` are both true.
- The D8 check happens **before** the diff: `stopAuto(..., 'target_limit_exceeded')` with no row changes.
- Hand-off: the reconciler calls `scheduler.markDirty` and `backfillQueue.enqueue(added)` without awaiting them.
- **Policy roles are channel-exact.** They are included only when the ROLE flag is on **and** `tracked.channelType ∈ {ChannelType.GuildText, ChannelType.GuildAnnouncement}`, looked up by exact `channelId` (D4). Threads and forum posts (types 10/11/12) never get policy roles.

**Tests:**
- **guild-queue:**
  - `tasks for one guild run in order`
  - `different guilds run concurrently`
  - `runKeyed merges a duplicate request while the first is still pending (task runs once)`
  - **`runKeyed lossless`:**
    1. state = A
    2. `runKeyed("k")` starts, reads A, and is gated
    3. while it runs, set state = B and call `runKeyed("k")` again
    4. release
    5. **exactly two executions**, and the final stored result equals B
  - `runKeyed dirtied three times while running → still exactly one trailing rerun`
  - **`nested same-guild run throws NestedGuildQueueError` (instead of hanging; the test has a 1 s timeout)**
  - `nested run for a DIFFERENT guild is allowed`
  - `assertInQueue throws outside a task and passes inside`
  - `a throwing task does not block the queue`
- **guild-health:**
  - initial state is `awaiting_guild` (paused)
  - `set(healthy)` → not paused
  - **fake timers:** entering a pause schedules `onPauseNoticeDue` after exactly 60 000 ms. It is not called at 59 999 ms, and it is **not called** if the guild becomes healthy before 60 000 ms (flap).
  - `resetAll` → every guild `awaiting_guild`
- **role-dependence:** only user sources → false; any role → true. Roles-off rule:
  - explicit-only targets → false
  - any target ∉ user sources → true
  - any role source row → true
- **target-reconciler** (real SQLite + fakes):
  - `role gained → added with fresh addedAt`
  - `role lost with no other source → removed with evidence+ack`
  - `explicit source keeps user after role loss`
  - `second role keeps user`
  - `mentioned role + policy role overlap → one target`
  - `zero → destructive stop no_eligible_targets`
  - `desired 101 → target_limit_exceeded, stored targets unchanged (exact equality before/after)`
  - `stopped tracking → inactive (never revived)`
  - `manual tracking untouched`
  - `paused + role-dependent → skipped_paused, no writes`
  - `paused + explicit-only → reconciles`
  - `thread tracking ignores parent channel policy`
  - `backfill queue bounded to 2 concurrent and coalesces users per tracking`

Commit: `feat(app): guild queue, auto-track health, role-dependence, target reconciler`

### Task 11 — Discord port extensions and fakes
**Files:** modify `src/app/ports.ts`, `src/discord/discord-port.ts`, `test/helpers/fake-discord.ts`, `test/unit/core-port.test.ts`.

**Interfaces** (added to `DiscordPort`):
```ts
listGuildMembers(guildId, after: Snowflake | undefined, limit: number): Promise<Lookup<{ userId; roleIds: Snowflake[]; bot: boolean }[]>>
getGuildRoleIds(guildId): Promise<Lookup<Snowflake[]>>
```
`CoreDiscordPort` implements them with `api.guilds.getMembers(guildId, { limit, after })` and `api.guilds.getRoles(guildId)`, mapping errors via `lookupFailure`. `bot` is `u.bot === true`.

**Tests** (`core-port.test.ts`, fake API):
- `listGuildMembers passes limit 1000 and after, maps roles and bot`
- `403 → Permanent, 5xx → Transient`
- `getGuildRoleIds maps ids`
- The fake gets a paged member store (ascending ids) and role store, with failure injection.

Commit: `feat(port): guild member listing and role ids`

### Task 12 — Member-state rebuild and recovery
**Files:** create `src/app/member-state-rebuilder.ts`, `test/integration/member-recovery.test.ts`.

**Interfaces:**
```ts
class MemberStateRebuilder {
  constructor(deps: { port; policies: PolicyRepository; repo; roleDeletion: RoleDeletionStore; index; health;
                      queue: GuildQueue; reconciler: TargetReconciler; scheduler; policy; clock; logger })
  /** A. External entry points: never awaited by queue tasks. Use queue.runKeyed. */
  requestRebuild(guildId, reason: "guild_create" | "retry"): void            // key "rebuild"
  requestRecoveryReconcile(guildId): void                                   // key "recovery-reconcile"; index-only, no REST
  /**
   * B. Caller already owns the guild queue (asserted via queue.assertInQueue). Never calls queue.run/runKeyed.
   * extraReferencedRoleIds lets PolicyService load not-yet-committed roles before validating D8.
   */
  rebuildNowInQueue(guildId, reason: "guild_create" | "retry" | "roles_grew",
                    opts?: { extraReferencedRoleIds?: readonly Snowflake[]; reconcile?: boolean /* default true */ })
    : Promise<"healthy" | "failed">
  needsRebuild(guildId): Promise<boolean>   // enabled role policies OR active role-dependent auto trackings
  dispose(): void
}
```

**Call graph (no nested queue execution):**
- `GUILD_CREATE` (coordinator) and the retry timers call `requestRebuild` → `queue.runKeyed(g, "rebuild", () => rebuildNowInQueue(g, reason))`.
- `PolicyService` target-increasing mutations are already inside `queue.run(g, …)`. They call `rebuildNowInQueue(g, "roles_grew", { extraReferencedRoleIds: newRoles, reconcile: false })` directly, then validate, commit, and call `reconciler.reconcileChannelInQueue`.
- Offline role pruning happens inside `rebuildNowInQueue`: it calls `roleDeletion.apply(g, roleId, at)` (a DB transaction, no queue) and `index.dropRole`. **It never calls the coordinator's enqueuing `onRoleDeleted`.**
- Member events are enqueued with `queue.run(g, …)` by the coordinator. Any that arrive while a rebuild is in progress wait behind the task holding the slot, and apply afterwards.
- **Global limit.** The global `p-limit(1)` is taken only around the member pagination (step 3) and released before reconciling. A guild waiting for the limiter never waits on another guild's queue, so there is no cross-guild cycle.
- **Retry scheduling.** On failure the timer calls `requestRebuild(g, "retry")` (external) later. It is never awaited inside the current task.

**Algorithm (`rebuildNowInQueue`, §9.2):**
1. Set `rebuilding`.
2. `getGuildRoleIds`. For each policy or message role id missing from the guild: `roleDeletion.apply` + `index.dropRole`. On failure, go to step 6.
3. Set referenced roles to `policies.referencedRoleIds(g)` ∪ `repo.activeMessageRoleIds(g)` ∪ `extraReferencedRoleIds`. Page `listGuildMembers(after = highest id, limit 1000)` until a page is short, then `replaceSnapshot`. On failure, go to step 6.
4. If `reconcile !== false`: set `reconciling`, then `reconciler.reconcileGuildInQueue`. On a DB failure, stay `reconciling` (paused) and schedule the external `requestRecoveryReconcile(g)` after `reconcileRetryMs`. That method is `queue.runKeyed(g, "recovery-reconcile", …)` and re-runs only `reconcileGuildInQueue` from the index (**no REST**, spec §9.2); on success it continues with step 5.
5. Set `healthy`, log `auto-track resumed {guildId, pausedForMs, attempt}`, and hand off `markDirty` for every role-dependent active auto card (non-blocking).
6. On failure: set `failed`, log `auto-track paused {guildId, reason, code, attempt, nextRetryInMs}` (403 adds the Portal-intent hint), and schedule `requestRebuild(g, "retry")` with backoff 60 s → 300 s → 900 s → every 900 s.

**Tests:**
- `paginates 2 500 members in 3 calls of limit 1000 with correct after cursors`
- `snapshot then queued member event applies after snapshot` (an event enqueued during the rebuild lands after it)
- `roles fetch failure → failed, nothing pruned, no target writes, retry at 60s (fake timers), then 300s, 900s, 900s`
- `403 logs Server Members intent hint`
- `recovery order: rebuilding → reconciling → healthy, reconcile runs before healthy, resumed log emitted, cards marked dirty`
- `DB failure during reconcile stays reconciling and retries after 60s via requestRecoveryReconcile, with zero listGuildMembers/getGuildRoleIds calls on the retry`
- `global concurrency: two guilds rebuild sequentially (max 1 in flight)`
- **`offline-deleted role pruning during rebuild completes without nested queue execution`**: a spy on `queue.run`/`runKeyed` records zero same-guild calls during `rebuildNowInQueue`; no `NestedGuildQueueError`; the policy is auto-disabled and `tracking_sources` is pruned; the rebuild resolves.
- **`rebuildNowInQueue called from inside a queue task completes`** (the old design deadlocked here): wrapped in `queue.run(g, …)`, it resolves within fake time.
- `rebuildNowInQueue outside a queue task throws (assertInQueue)`
- `requestRebuild twice while one is running → exactly one trailing rebuild (lossless runKeyed)`
- `guild with no role work becomes healthy without REST calls`
- `manual tracking acknowledge works while guild is failed`

Commit: `feat(app): member-state rebuild with fail-closed recovery`

### Task 13 — Adapters: auto-track candidate and member events
**Files:** modify `src/discord/adapters/message.ts`; create `src/discord/adapters/member.ts`, `test/unit/adapters-auto-track.test.ts`; extend `test/fixtures/gateway.ts` (mentions, forward, thread, member payloads).

**Interfaces:**
```ts
export function messageToAutoTrackCandidate(
  d: MessageCreateLike, flags: { mentionAutoTrack: boolean; roleTargets: boolean }): AutoTrackCandidate | null
export function memberUpsertToEvent(d): MemberStateEvent | null   // ADD & UPDATE; requires guild_id, user
export function memberRemoveToEvent(d): MemberStateEvent | null
export function roleDeleteToEvent(d): MemberStateEvent
export function guildCreateToEvent(d): MemberStateEvent           // guild_available
```

**Candidate rules** (§8.1):
- `guild_id` must be present.
- `type === MessageType.Default`.
- `!author.bot` and no `webhook_id`.
- `channel_type` must be present **and** in `SUPPORTED_CHANNEL_TYPES` (imported from `src/discord/permissions.ts`, not duplicated).
- `outerUsers = mentions − bots − author`; `outerRoles = mention_roles − guildId`.
- **Forwards** (`message_reference?.type === MessageReferenceType.Forward || flags & MessageFlags.HasSnapshot`):
  - build a **local, temporary** set of snapshot mention ids from `message_snapshots[].message.mentions[].id` and `.mention_roles[]`
  - drop any outer id that is in that set
  - discard the set before returning
  - snapshot ids never become sources; snapshot `content` / `embeds` / `attachments` are never read (Global Constraint 6)
  - Test: `forward candidate object contains no snapshot-derived fields` (deep-equality on the returned shape).
- **Flag filtering:**
  - `explicitUserIds` only when `mentionAutoTrack` is on
  - `mentionedRoleIds` only when both flags are on
  - `mention_everyone` is ignored
- The candidate may have empty source lists; the coordinator adds policy roles. Return `null` only for trigger failures.

**Tests:**
- `top-level human in text channel → candidate`
- `reply (type 19) → null even with mentions`
- `bot author → null`
- `webhook → null`
- `status card (bot author) → null`
- `DM → null`
- `missing channel_type → null`
- `voice text channel_type (2) → null`
- `public thread 11 / private thread 12 / announcement thread 10 / forum post (11) → candidate`
- `@everyone (mention_everyone true, no ids) → empty sources`
- `<@&guildId> removed`
- `bots and author removed from explicit users`
- `mentions off → explicitUserIds [] and mentionedRoleIds []`
- `mentions on + roles off → roles []`
- `forward: snapshot-only mentions ignored`
- `forward: outer id not in snapshot kept`
- `forward: outer id also in snapshot dropped (fail closed)`
- `member UPDATE maps roles and bot (bot absent → false)`
- `member ADD for existing member maps identically`
- `REMOVE maps`

Commit: `feat(adapters): auto-track candidate and member-state events`

### Task 14 — Coordinator phase A/B: auto-track creation (both triggers)
**Files:**
- create `src/app/auto-track-coordinator.ts`, `test/integration/auto-track.test.ts`, `test/integration/mention-auto-track.test.ts`
- modify `src/app/tracking-service.ts`, `test/helpers/app.ts` (build the M9 graph with flags)

**Interfaces:**
```ts
// tracking-service.ts
insertAutoTracking(input: { guildId; channelId; parentChannelId: Snowflake | null; sourceMessageId; sourceAuthorId;
  sourceCreatedAt; targets: readonly Snowflake[]; sources: readonly TargetSource[] })
  : Promise<{ ok: true; tracked: TrackedMessage } | { ok: false; reason: "exists" }>
publishAutoCompanion(trackedId: number): Promise<"published" | "rolled_back" | "gone">
// auto-track-coordinator.ts
class AutoTrackCoordinator {
  constructor(deps: { features; repo; policies; registry; health?; index?; queue; reconciler; service; scheduler;
                      backfill: Pick<Reconciler, "initialBackfill">; policy; clock; logger })
  onTopLevelMessage(c: AutoTrackCandidate): Promise<void>
}
```

**Phase A** runs in `queue.run(guildId)`:
1. Collect sources. Policy roles come only when roles are on **and** `channelType ∈ {GuildText, GuildAnnouncement}`, looked up by exact `channelId`. No sources → return.
2. If `isRoleDependent(sources)` and the guild is paused → debug log and return. Explicit-only candidates continue.
3. Compute `desiredTargets`. Empty → return.
4. `> autoTrackMaxTargets` → warn, rate-limited to one per channel per 10 min, and return.
5. `insertAutoTracking` (`creator = author`, `added_at = createdAt`). On `exists`, return silently.

**Phase B** runs outside the queue: `publishAutoCompanion`, then `initialBackfill`.
- `insertAutoTracking` stores `channelType` from the candidate (Task 6).
- `parentChannelId` is not in the gateway payload and stays NULL for auto trackings. Thread and forum trackings are recognised by `channelType` (Task 10), never by `parentChannelId`.

**Tests** (`auto-track.test.ts`):
- `policy channel plain message → one auto card, targets = policy role members minus author/bots, origin auto, creator author`
- `two policies → one card, union targets`
- `replayed MESSAGE_CREATE → one row, one createCompanion call`
- `after auto tracking stopped, replay → no new tracking (permanent uniqueness)`
- `zero eligible → no row, no createCompanion`
- `101 eligible → no row + one warn; second message within 10 min → no second warn`
- `paused guild + policy channel → no creation`
- `publish failure rolls back row and sources`
- `member event during pending publish reflected after publish` (companion gate from the existing FakeDiscord)
- `reconcile-stop during pending publish renders frozen card`
- `phase B not awaited by queue` (a second guild task runs while publish is gated)
- `gap-scan (Reconciler.recoverGap) messages never create auto tracking` (feed history containing a qualifying message: zero auto rows)

**Tests** (`mention-auto-track.test.ts`), covering spec M1–M15:

| Test | Expectation |
|---|---|
| M1 | `@user in unconfigured channel → tracking + user source row` |
| M2 | `@role (both flags) → members + role source row` |
| M3/M4 | `@everyone/@here → no tracking` |
| M5 | `<@&guildId> ignored` |
| M7 | `author self-mention excluded` |
| M8 | Dedupe cases |
| M9 | `mention + policy → exactly one card, union` |
| M11 | `replay → sources inserted once` |
| M12 | `limit after full union 101 → none, 100 → created` |
| M13 | `only bots/author/empty role → none` |
| **M14a** | `M on R off @user → tracking, no role rows, intents 3585` |
| **M14b** | `M on R off @role only → none` |
| **M14c** | `M on R off @user+@role → user only; later ROLE on does not add role (frozen)` |
| M14d | `M off R on → policies only, mentions not collected` |
| **M15a** | `paused + explicit-only → created, card has no pause notice` |
| **M15b** | `paused + explicit+mentioned role → none; paused + explicit in policy channel → none` |
| **M19** | `thread and forum-post mention → message sources only` |
| **M20** | `parent policy not applied in thread; parent policy change never reconciles thread tracking` |
| **M21/M22** | Forward snapshot ignored; outer kept; overlap dropped |

Commit: `feat(app): auto-track creation for mention and policy triggers`

### Task 15 — Coordinator: member events, role deletion, policy-change reconcile, D2
**Files:** extend `src/app/auto-track-coordinator.ts`; create `test/integration/member-events.test.ts`, including a `describe("role delete")` block.

**Interfaces** (added to `AutoTrackCoordinator`):
```ts
onMemberEvent(e: MemberStateEvent): Promise<void>   // EXTERNAL: each event → queue.run(e.guildId, …); never called from inside a task
onReady(): void                                      // health.resetAll() (synchronous, no queue)
private applyRoleDeletionInQueue(guildId, roleId, at): Promise<void>   // INTERNAL; asserts queue ownership
requestReferencedRolePrune(guildId): void                           // EXTERNAL: queue.runKeyed(g, "prune-referenced-roles", …)
pruneReferencedRolesInQueue(guildId): Promise<void>                 // INTERNAL/in-queue; shrink-only
```

**Rules** (every branch runs inside the single `queue.run` opened by `onMemberEvent`):
- **Upsert / remove while paused:** dropped.
- **Upsert otherwise:**
  1. `index.upsert`
  2. if `changedRoleIds` is non-empty, target ids = `repo.listActiveAutoIdsByMessageRoles(g, changed)` ∪ the trackings in `policies.enabledChannelIdsForRoles(g, changed)` (via `repo.listActiveAuto({ guildId: g, channelIds })`, keeping text/announcement `channelType` only)
  3. `reconciler.reconcileInQueue(id)` for each target id
- **Remove:** `index.remove`, then `reconcileInQueue` for each id in `repo.listActiveAutoIdsWithTarget(g, user)`. Explicit sources keep the user (E6).
- **Role delete** (`applyRoleDeletionInQueue`, also used by nothing else):
  1. `roleDeletion.apply(g, role, at)` (**one transaction**, Task 7b)
  2. `index.dropRole`
  3. if the guild is healthy: `reconcileInQueue` for each `affectedTrackingIds`, plus `reconcileChannelInQueue` for each `affectedChannelIds`

  If paused, the transaction still commits and the reconcile happens at recovery (`reconcileGuildInQueue`).
- **`guild_available`:** `rebuilder.requestRebuild(g, "guild_create")`. It is external scheduling: the rebuild runs as its own keyed task after the current one.
- **`guild_unavailable`:** health → `unavailable`.
- **Referenced-role shrink (keeps the in-memory index from retaining unreferenced membership).**
  - `private pruneReferencedRolesInQueue(g)` recomputes `policies.referencedRoleIds(g) ∪ repo.activeMessageRoleIds(g)` and calls `index.setReferencedRoles(g, …)`. It **only shrinks**: if the recomputed set contains roles that are not already indexed, those roles are left out, because growth needs a rebuild.
  - **Called inline** (already in-queue) after `applyRoleDeletionInQueue`, and by `PolicyService` after target-decreasing commits (Task 18).
  - **Called periodically** through the external `requestReferencedRolePrune(g)` = `queue.runKeyed(g, "prune-referenced-roles", …)`. The existing `Sweeper` interval (5 min) triggers it for each indexed guild (wired in Task 20). This catches references that disappear when trackings stop or expire, without hooking every stop path.
  - **Tests:**
    - `role removed from its last enabled policy → after the next prune tick (fake timers, 5 min), index.membersOf(role) is empty and its members are gone from the index`
    - `auto tracking holding the only message-role source stops → role dropped after next prune tick`
    - `role still referenced by another policy or active tracking is kept`
    - `prune never adds members for a newly referenced role`
    - `prune runs via runKeyed (no nested queue call)`
- **`guild_removed`:** clear the index and `health.forget(g)` only. The tracking purge (existing) and the **policy purge** happen through the lifecycle hook (Task 20), so they also run when both flags are off.
- **Only these enqueue:**
  - `onTopLevelMessage` (Task 14)
  - `onMemberEvent`
  - `rebuilder.requestRebuild`
  - `PolicyService` mutations (Task 18)

  Nothing inside a task calls any of them.

**Tests** (`member-events.test.ts`):
- `role gained → added (fresh addedAt)`
- `role lost → removed + evidence/ack deleted`
- `switch between two qualifying roles → stays (same target row, addedAt unchanged)`
- `multi-role lose one → stays`
- `explicit + lose role → stays`
- `member leaves: role-derived removed, explicit stays (E6)`
- `rapid duplicate updates → one reconcile write, idempotent`
- `nickname-only update → no DB writes`
- `manual tracking untouched by member events`
- `paused → events dropped, no writes`
- **`D2 regression`** (spec §6.4, all 12 steps):
  1. C targeted via `@QA`
  2. C confirms
  3. C direct-replies (fake history holds the reply)
  4. C loses `@QA`
  5. target, ack and reply-evidence rows = 0
  6. C regains `@QA`
  7. new target with `added_at` > the old one
  8. no ack row
  9. no weak evidence dated before the new `added_at`
  10. backfill rediscovers the reply → DIRECT_REPLY row
  11. an existing reaction is rediscovered by the reaction pass
  12. projection = INTERACTED "replied", **not** CONFIRMED
- `weak evidence respects dynamic addedAt` (typing before the re-add not counted; after it, counted)

**Tests** (`member-events.test.ts` › `role delete`):
- `live delete prunes policy + tracking_sources role rows`
- `users qualified elsewhere stay; others removed`
- `zero → no_eligible_targets`
- `enabled policy losing last role → auto_disabled_missing_role (state_changed_by '0')`
- `user_disabled policy losing last role → stays user_disabled`
- `paused → pruning committed, reconcile deferred until healthy`
- `duplicate delete event → no-op`

Commit: `feat(app): dynamic reconciliation from member, role and policy changes`

### Task 16 — Card rendering and scheduler (pause notice, labels, stop lines, edit cap)
**Files:** modify `src/app/ports.ts` (`CardView.autoTrackPaused?: boolean; maxTargets?: number`), `src/discord/render/card.ts`, `src/discord/render/text.ts`, `src/app/render-scheduler.ts`, `src/app/tracking-service.ts` (`renderCard` pause-aware), `test/unit/card.test.ts`, `test/integration/render-scheduler.test.ts`.

**Rules:**
- **Header:** add the `Auto-tracked ·` prefix when `origin === 'auto'`.
- **Pause notice:** exact text `-# ⏸ Auto-track temporarily paused — member state is unavailable. Last known targets are shown.` Shown only when `autoTrackPaused`, which is computed by an injected `pauseProvider(t)`. It is true iff auto, active, `isRoleDependent(await reconciler.sourcesFor(t))`, and `health.isPaused`.
- **Overflow:** at most 25 user lines, then `-# +N more not shown (counts are complete)`.
- **Stop lines:**

  | Stop reason | Line |
  |---|---|
  | `no_eligible_targets` | "Tracking ended · no eligible targets remain" |
  | `target_limit_exceeded` | "Tracking ended · too many eligible members (limit L)" |
  | `feature_disabled` | "Tracking ended · role-based auto-track was turned off" |

- **Scheduler:** new dependency `pauseProvider` (default `async () => false`). A global `p-limit(policy.renderEditConcurrency)` wraps `port.editCompanion`.
- **Grace refresh:** `health.onPauseNoticeDue(g)` → `markDirty` for each role-dependent active auto tracking in `g`.

**Tests:**
- **card:**
  - `manual card byte-identical to pre-M9 snapshot (hash equality with a stored fixture hash)`
  - `auto label`
  - `pause notice only when flag true`
  - `notice changes hash`
  - `overflow at 26 targets shows 25 lines + "+1 more", header counts 26`
  - `three new stop lines, no buttons`
  - `allowed_mentions.parse empty`
  - `no <@& in any card text`
- **scheduler:**
  - `max 2 editCompanion in flight with 10 dirty cards (instrumented fake)`
  - `existing debounce/serialization tests unchanged and green`
  - `unchanged hash not resent`
  - `pause beyond 60s marks only role-dependent active auto cards dirty; explicit-only and manual not edited`
  - `pause resolved at 59s → zero edits`
  - `resume + reconcile markDirty coalesce into one edit per changed card`
  - `with flags off, a run of the existing scheduler suite yields identical edit counts`

Commit: `feat(render): auto label, pause notice, overflow, stop lines, global edit cap`

### Task 17 — Acknowledgement authorization (R12) and auto Manage
**Files:** modify `src/discord/interactions/buttons.ts` (`handleManage` Stop-only for auto; `handleTargets` refuses auto) and `src/discord/render/text.ts` (the auto Manage note); create `test/integration/ack-authorization.test.ts`. **`repo.acknowledge()` is unchanged** (it is already transactional); the tests pin its behaviour.

**Tests** (A1–A13 from the spec):

| # | Test |
|---|---|
| A1 | `current auto target confirms, count +1` |
| A2 | `source author on auto card → "You're not a tracked target for this message.", zero writes (row counts of acknowledgements/evidence/targets identical), no editCompanion/UPDATE_MESSAGE` |
| A3 | `non-target rejected, zero writes` |
| A4 | `removed target rejected; target not recreated; evidence not restored` |
| A5 | `dynamically added target confirms via the existing card's custom_id (no new card)` |
| A6 | `explicit+lost role still confirms` |
| A7 | `rejected click → no render` |
| A8 | `stale card: target row deleted after last render → rejected; wrong message id → outdated` |
| A9 | `new app instance on same DB → same outcomes` |
| A10 | `manual current target confirms; manual non-target rejected; role/policy changes don't alter manual targets` |
| A11 | `interleave acknowledge and reconcileAutoTargets removal both orders → never an ack row for a non-target` |
| A12 | `paused guild: persisted target confirms; after recovery removes them, ack gone` |
| A13 | **Composite** over the fixtures from Tasks 14–15: roles-off `@Dev` user, an edited-in user, snapshot users and a parent-policy user in a thread are rejected. The outer forwarder mention, the thread target and the explicit user who left are accepted/retained. |

Also:
- `auto Manage shows only Stop`
- `sb1:targets on auto tracking → refusal text`

Commit: `test(ack): current-target authorization for auto and manual; auto Manage stop-only`

### Task 18 — Configuration authorizer and policy service
**Files:** create `src/app/config-authorizer.ts`, `src/app/policy-service.ts`, `test/unit/config-authorizer.test.ts`, `test/integration/policy-service.test.ts`.

**Interfaces:**
```ts
type ConfigAction = "policy.create" | "policy.list" | "policy.edit" | "policy.delete";
interface ConfigActor { userId: Snowflake; guildId: Snowflake | undefined; memberPermissions: string | undefined }
class ConfigAuthorizer { authorize(actor: ConfigActor, action: ConfigAction, scope: { guildId: Snowflake; channelId?: Snowflake })
  : { ok: true } | { ok: false; reason: string } }   // M9: ok iff actor.guildId === scope.guildId
type PolicyResult<T> = { ok: true; value: T } | { ok: false; error: "paused" | "over_limit" | "needs_role" | "everyone_role"
  | "not_found" | "invalid_state"; detail?: { resolved?: number; limit?: number } };
class PolicyService {           // each public mutation = exactly one queue.run(guildId, …); inside it only …InQueue calls
  create(actor, { channelId, name, roleId }): Promise<PolicyResult<AutoTrackPolicy>>
  saveRoles(actor, policyId, roleIds): Promise<PolicyResult<AutoTrackPolicy>>   // auto re-enable only from auto_disabled
  setState(actor, policyId, action: "disable" | "enable" | "keep_disabled"): Promise<PolicyResult<AutoTrackPolicy>>
  rename(actor, policyId, name): Promise<PolicyResult<AutoTrackPolicy>>
  delete(actor, policyId): Promise<PolicyResult<void>>
  channelStatus(guildId, channelId): Promise<{ paused: boolean; resolved?: number; limit: number; overLimit: boolean }>
}
```

**Rules:**
- **Tenant isolation:** `policy.guildId` must equal `actor.guildId`, otherwise `not_found`. This is enforced in the service, not delegated to the authorizer.
- **Target-increasing changes** (create, add roles, enable, auto re-enable). All inside the mutation's own `queue.run(g, …)`:
  1. need a healthy guild (`paused` otherwise)
  2. if roles not yet in `index.referencedRoles(g)` are involved: `await rebuilder.rebuildNowInQueue(g, "roles_grew", { extraReferencedRoleIds: newRoles, reconcile: false })`. This is the **in-queue** form, never `requestRebuild`. A `"failed"` result → `paused`, with nothing committed.
  3. run the D8 check on the channel's resulting enabled union, excluding bots (`over_limit` with `resolved`/`limit`)
  4. commit, then `reconciler.reconcileChannelInQueue(g, channelId)`
- **Target-decreasing changes** always commit, then `reconciler.reconcileChannelInQueue`, then `coordinator.pruneReferencedRolesInQueue(g)` (Task 15). The reconcile skips role-dependent trackings while paused, and the recovery reconcile applies them later.
- **No policy-count limit.** The spec approves none (Global Constraint 13).

**Tests:**
- **Authorizer:** `ordinary member without permissions authorized`, `different guild rejected`.
- **Service:**
  - `create`
  - `multiple policies per channel union`
  - `rename`
  - `disable → user_disabled`
  - `enable with roles → enabled`
  - `enable with zero roles → needs_role`
  - `keep_disabled → user_disabled`
  - `saveRoles on auto_disabled → enabled`
  - `saveRoles on user_disabled → stays user_disabled`
  - `@everyone (roleId === guildId) → everyone_role`
  - `30 policies in one channel can be created (no count limit)`
  - `over limit create → over_limit, nothing committed`
  - **`policy add-role that needs a rebuild completes`** (the old design deadlocked here): `saveRoles` with a role not yet indexed resolves; the fake `listGuildMembers` was called; the policy is saved; no `NestedGuildQueueError`.
  - **`member event arriving during that rebuild runs afterward`**:
    - gate `listGuildMembers`, call `saveRoles`, then call `onMemberEvent(upsert)`
    - release the gate
    - the order log is `[rebuild, saveRoles-commit, member-upsert]`, and the final targets reflect the upsert
  - `paused: create/add-role/enable → paused, nothing committed; disable/delete/remove-role committed and reconciled after recovery`
  - `cross-guild policyId → not_found`
  - `delete → reconcileChannelInQueue reconciles that channel's active auto trackings only`

Commit: `feat(app): config authorizer and policy service`

### Task 19 — `/autotrack` command, policy panel, routing, custom ids
**Files:**
- modify `src/discord/commands.ts`, `src/discord/custom-id.ts`, `src/discord/interactions/router.ts`, `test/unit/custom-id.test.ts`, `test/helpers/interactions.ts` (chat-input / modal / role-select fixtures)
- create `src/discord/interactions/config/autotrack.ts`, `src/discord/interactions/config/policy-panel.ts`, `test/unit/commands.test.ts`, `test/integration/config-interactions.test.ts`

**Interfaces:**
- `CustomId` gains:
  - `{ action: "ap-roles" | "ap-state" | "ap-rename" | "ap-rename-submit" | "ap-delete" | "ap-delete-confirm" | "ap-view"; policyId: number }`
  - `| { action: "ap-open"; channelId: Snowflake }`
- `autotrackCommand` is a CHAT_INPUT command named `autotrack`:
  - subcommand `create` with `channel` (type 7, `channel_types [0,5]`, required), `name` (type 3, `max_length 100`, required) and `role` (type 8, required)
  - subcommand `list` with `channel` (optional, same `channel_types`) and `page` (type 4 INTEGER, optional, `min_value 1`)
  - no `default_member_permissions`; global `integration_types [0]`, `contexts [0]`
- `commandsFor(scope)` returns `[trackSeenCommand, autotrackCommand]`, with global-only fields stripped for guild scope.

**Handler behaviour (spec §12):**
- `create` and `list` defer an ephemeral reply.
- A panel shows state text (`auto_disabled` → *"Disabled — its last role was deleted. Add a role to re-enable."*).
- The Role Select has `min 1`, `max 25` and `default_values`.
- The state button label is Disable, Enable or **Keep disabled**.
- Rename uses a modal. Delete shows a confirm step.
- With the role flag off, every `/autotrack` interaction gets an ephemeral *"Role-based auto-track is disabled on this bot (ROLE_TARGETS_ENABLED=false)."*
- Every response carries `allowed_mentions {parse: []}`.
- `list` shows the "Mention auto-track: on/off" / "Role targets: on/off" lines and per-channel paused / over-limit status.
- **`list` pagination** (a Discord component and message-length constraint, not a product limit):
  - 10 policies per page, ordered by id, via `listForChannel(channelId, { offset: (page-1)*10, limit: 10 })`
  - one line per policy: `#id · name · state · N roles` (role mentions appear only in the single-policy panel)
  - a String Select `sb1:ap-open:<channelId>` lists that page's policies
  - footer: `Page p of ⌈count/10⌉ — use /autotrack list page:<n>`
  - a page out of range → the last page
- **Selected-channel permission warning (verified).**
  - **Source:** the official docs (`interactions/receiving-and-responding` › Resolved Data Structure: partial channels include `app_permissions`; changelog 2026-07-16: *"Resolved channel objects in interaction payloads now include an `app_permissions` field containing the bot's permissions in that channel. This field is only present when the application's bot user is in the guild."*). The installed discord-api-types 0.38.55 types it as optional on `APIInteractionDataResolvedChannelBase`.
  - **Which field:** `create` reads `interaction.data.resolved.channels[channelOptionId].app_permissions`. That is the **selected** channel. The invocation channel's `interaction.app_permissions` is **never** used for this.
  - **If the field is present:** warn when VIEW_CHANNEL, SEND_MESSAGES or READ_MESSAGE_HISTORY is missing. The policy is still created (§12.3).
  - **If the field is absent:** show **no** warning (never guess), and rely on the existing companion-post error handling. There is **no REST lookup**.
  - The payload shape is a live check in M9-33.

**Tests:**
- **commands:** `Track Seen unchanged`, `autotrack shape exact`, `guild scope strips integration_types/contexts`, `no default_member_permissions`.
- **custom-id:** round-trips for all new actions; ≤100 characters; malformed ids rejected.
- **config-interactions:**
  - `create happy path shows panel`
  - `disabled flag reply`
  - `over-limit and paused rejections render errors`
  - `role select saves and auto re-enables`
  - `Keep disabled`
  - `rename modal`
  - `delete confirm`
  - `forged ap-* custom_id with other guild's policyId → "This control is outdated", no change`
  - `list shows flag lines`
  - `list pagination: 23 policies → page 1 shows 10 + "Page 1 of 3"; page:3 shows 3; page:9 → page 3`
  - `permission warning uses resolved selected-channel app_permissions (missing SEND_MESSAGES → warning); invocation-channel app_permissions lacking perms but selected channel OK → no warning; resolved app_permissions absent → no warning and no REST call`
  - `ordinary member allowed`

Commit: `feat(config-ui): /autotrack command and policy panel`

### Task 20 — Startup, feature-disabled sweep, gateway wiring, composition
**Files:** modify `src/app/startup-recovery.ts`, `src/app/tracking-service.ts` (lifecycle hooks), `src/discord/gateway.ts`, `src/bot.ts`, `src/main.ts`; create `test/integration/feature-flags.test.ts`, `test/integration/lifecycle-cleanup.test.ts`; extend `test/integration/bot.test.ts`.

**Lifecycle cleanup (reuses the existing path, no parallel gateway pipeline).**
- **Today:**
  - `CHANNEL_DELETE` / `THREAD_DELETE` go through `channelDeleteToSignal` / `threadDeleteToSignal` → `service.recordSignal({ t: "CHANNEL_DELETED" })` → the existing stop (`src/app/tracking-service.ts` case `"CHANNEL_DELETED"`).
  - `GUILD_DELETE` (not unavailable) → `GUILD_REMOVED` → `repo.purgeGuild` (case `"GUILD_REMOVED"`).
- **Change:** extend `TrackingService.hooks` (today `SignalFailureHooks`) with lifecycle callbacks, invoked **after** the existing handling in those two cases:
  ```ts
  interface LifecycleHooks {
    onChannelDeleted(channelId: Snowflake): Promise<void>;
    onGuildRemoved(guildId: Snowflake): Promise<void>;
  }
  // default: no-ops (existing tests unaffected)
  ```
- **Wiring in `createBot`, always, regardless of the M9 flags** (policies may remain from an earlier role-enabled period):
  - `onChannelDeleted` = `policies.deleteChannelPolicies(channelId)`. That deletes that channel's policies; their source rows cascade.
  - `onGuildRemoved` = `policies.purgeGuild(guildId)`, then (if a coordinator exists) `coordinator.onMemberEvent({ t: "guild_removed" })` to clear the index and health.
- Existing tracking-stop and guild-purge behaviour stays unchanged. A thread id passed to `deleteChannelPolicies` matches nothing, since policies exist only on text/announcement channels.

**Interfaces and rules:**
- `stopRoleDependentAutoTrackingsWhenDisabled(repo, logger, at): Promise<number[]>`:
  - for each active auto tracking, apply `isRoleDependentWhenRolesOff(sources, targetIds)`
  - matching trackings get `stopAuto(…, 'feature_disabled')`, with rows kept
  - the returned ids are refreshed through the scheduler
- **Referenced-role prune wiring** (role flag on only): after each `sweeper.runOnce()` tick, call `coordinator.requestReferencedRolePrune(g)` for every guild that `MemberRoleIndex` holds. This is an external scheduling call, never made from inside a queue task. Test: `sweeper tick schedules a prune per indexed guild`.
- **`BotOptions`** gains `features`. `createBot` builds the M9 graph:
  - the coordinator when **either** flag is on
  - the rebuilder, health and index **only** when the role flag is on
- **`start()` order:**
  1. migrate
  2. `deleteUnfinishedStarts`
  3. **if the role flag is off:** the feature-disabled sweep
  4. sweep
  5. create the gateway
  6. attach
  7. connect
- **`attachGateway`:**
  - `MessageCreate` → existing `recordSignal` **and** (if the coordinator exists) `messageToAutoTrackCandidate` → `onTopLevelMessage`
  - member / role-delete / guild-create / guild-delete events → `onMemberEvent`, **only** when the role flag is on
  - `Ready` → `coordinator.onReady()`
  - `Resumed` → no M9 action
  - `Closed(4014)` → `deps.onFatal("Disallowed intents: enable Server Members Intent in the Developer Portal or set ROLE_TARGETS_ENABLED=false")`
- **`main.ts`:** `new WebSocketManager({ intents: buildIntents(config.features) })` after `assertAllowedIntents`; `onFatal` → log and `process.exit(1)`.

**Tests:**
- **feature-flags:** the four matrix rows:
  - M0–M7 behaviour: no auto rows for a mention message, `/autotrack` disabled reply
  - explicit-only
  - policies only
  - full
  - plus the intents passed to the gateway factory are asserted
- **Sweep:**
  - `sweep stops mixed and role-derived auto trackings with feature_disabled, keeps rows`
  - `explicit-only auto in a channel with an (inert) enabled policy NOT stopped`
  - `manual untouched`
  - `sweep runs before gateway creation (order spy)`
  - `second start → no-op`
- **bot:**
  - `RESUMED triggers no rebuild and no health change`
  - `READY → all guilds awaiting_guild; GUILD_CREATE → rebuild`
  - `4014 invokes onFatal with the explicit message`
  - `member events not handled when role flag off`
- **lifecycle-cleanup:**
  - `CHANNEL_DELETE of a configured text channel → its policies and policy sources deleted; policies of another channel in the same guild and of other guilds untouched; active trackings in the channel stopped channel_deleted exactly as before`
  - `CHANNEL_DELETE with both M9 flags off still deletes that channel's leftover policies`
  - `THREAD_DELETE → no policy rows affected`
  - `GUILD_REMOVED → that guild's policies purged (other guild's intact) and tracked messages purged as before; with role flag on, index/health cleared`
  - `existing tracking-service lifecycle tests unchanged and green`

Commit: `feat(bot): M9 composition, gateway wiring, feature-disabled startup sweep`

### Task 21 — Message edits (E1) and end-to-end restart/idempotency
**Files:** create `test/integration/message-update.test.ts`; extend `test/integration/member-recovery.test.ts`.

**Tests:**
- **#40a** `edit @An→@Binh (MESSAGE_UPDATE dispatched through attachGateway) → sources/targets unchanged, An's ack kept`
- **#40b** `edit untracked message to add mention → no tracking`
- **#40c** `role/policy changes still reconcile after an edit`
- `restart: instance A creates role-dependent auto tracking; instance B on same DB starts awaiting_guild; ack render before rebuild shows pause notice; after GUILD_CREATE rebuild + reconcile → healthy, notice gone (one edit)`
- `fresh READY during healthy → awaiting_guild → rebuild`
- `replayed MESSAGE_CREATE across restart → no duplicate`

There is **no production code change** unless a test fails, and the E1 freeze needs none: `MESSAGE_UPDATE` stays unconsumed. If a test fails, fix it minimally and name the cause in the commit.

Commit: `test: message-edit freeze and restart/idempotency for M9`

### Task 22 — Privacy, docs, env
**Files:** `README.md`, `PRIVACY.md`, `.env.example`.

**Content:**
- The flag/intent matrix (§14.1).
- The limit, and Server Members plus 4014.
- Triggers, E4 scope vs D4 policy scope, `@everyone`/`@here`.
- Union and fixed vs dynamic sources.
- E1 edit freeze, E5 forwards, E6 explicit-user-leaves.
- Policy states, the pause and its notice, stop reasons.
- Acknowledgement authorization and `/autotrack`.
- Member-snapshot recovery vs the message watermark.
- The M8 → M9 gate.
- **PRIVACY.md:**
  - policy config, role ids, `tracking_sources` ids
  - the in-memory membership index (never persisted)
  - the Server Members intent
  - "mentioning someone can auto-create a status card when enabled"
  - `forget-user` coverage

**Check:** `grep -n "ROLE_TARGETS_ENABLED\|MENTION_AUTO_TRACK_ENABLED\|AUTO_TRACK_MAX_TARGETS" README.md .env.example PRIVACY.md` finds all three in README and `.env.example`.

Commit: `docs: M9 README, privacy and env documentation`

### Task 23 — M9 manual checklist
**Files:** `docs/manual-checklist.md`, which gets a new "M9" section containing:
- **Human setup (B)**, below
- M9-1 … M9-38 from spec §18, verbatim, each with a Flags column and a Result column
- ⚠ markers on M9-18/19/33

Commit: `docs: M9 manual Discord checklist`

### Task 24 — Final verification (report actual output)
1. `pnpm format && pnpm check`: typecheck, Biome, full Vitest. Report the file and test counts.
2. `pnpm test:coverage`: report the four percentages against the floor from Task 1.
3. **Build check.** The project has no compile step (type stripping), so:
   - `pnpm typecheck`
   - a smoke start: `DISCORD_TOKEN=dummy.token.value DISCORD_APPLICATION_ID=123456789012345678 DATABASE_PATH=<scratch>/seen.db timeout 15 node src/main.ts`
     - expected: `migrations applied` including `0002_auto_track`, then a 401 from Discord
   - repeat with `ROLE_TARGETS_ENABLED=true`
     - expected: the same 401, and a log showing intents 3587
4. `pnpm vitest run test/integration/migration-0002.test.ts test/unit/commands.test.ts test/unit/intents.test.ts`: report.
5. `docker build -t discord-seen-bot .`, then the container smoke run as in M7 (migrations applied, 401).
6. `git status --short`: only the intended files.
7. **Report honestly.** Every live Discord behaviour stays **manual/unverified** until a human runs the M9 checklist.

---

## B. Human Discord setup (only when M9 reaches live testing, after Task 24)

1. **Mention-only testing:** set `MENTION_AUTO_TRACK_ENABLED=true` and `ROLE_TARGETS_ENABLED=false` in `.env`. **Do not** enable Server Members Intent for this.
2. **Role / policy testing:** Developer Portal → your test app → **Bot** → Privileged Gateway Intents:
   - **Server Members Intent: ON**
   - **Presence Intent: OFF**
   - **Message Content Intent: OFF**
   - Then set `ROLE_TARGETS_ENABLED=true` (and `MENTION_AUTO_TRACK_ENABLED=true` for the combined items).
3. **Test server setup:**
   - create roles `@Dev`, `@QA` and `@Security`
   - create accounts A–E as in §18
   - assign and remove roles through Server Settings → Members during the checklist
   - Administrator is **not** required for the bot; keep the existing invite permissions `274877975552`
4. Re-register commands: `pnpm register-commands -- --guild <TEST_GUILD_ID>`. Confirm both "Track Seen" and `/autotrack` appear.
5. Restart the bot: `pnpm dev`, or restart the container.
6. Run `docs/manual-checklist.md` → the M9 section. Record Result, date and observed payload shapes for the ⚠ items.

---

## Self-review (writing-plans checklist)

**1. Spec coverage.** Every spec section maps to a task:

| Spec section | Task(s) |
|---|---|
| §3 requirements R1–R12 | 14 / 15 / 17 / 18 |
| E1 | 21 |
| E2 | 14 |
| E3 | 2 / 3 / 20 |
| E4 | 13 / 14 |
| E5 | 13 / 14 |
| E6 | 15 |
| D2 | 15 |
| D6 | 20 |
| D7 | 6 / 10 |
| D8 | 2 / 10 / 14 / 18 |
| D9 | 7b / 12 / 15 |
| D15 | 10 / 12 / 16 |
| D16 | 10 / 14 |
| §7 schema | 5 (including nullable `channel_type`) |
| §9 recovery | 12 |
| §9.4 render | 16 |
| §12 UX | 18 / 19 |
| §15 privacy | 6 / 7 / 22 |
| §16 test ids | M1–M23, A1–A13, #40, #41, 1–39 all named in Tasks 5–21 |
| §18 checklist | 23 |

**2. Step granularity.** Each task has a narrow test command, a named failing test, minimal implementation, a surrounding suite run and a commit.

**3. Type and interface consistency.**
- `TargetSource`, `PolicyState`, `GuildHealthState`, `AutoTrackCandidate` and `MemberStateEvent` are defined once (Task 4 / 10) and reused.
- The reconciler's `sourcesFor` is the single source for both the pause provider (Task 16) and the D6 sweep inputs (Task 20).
- `channel_type` is defined in Task 5, stored in Task 6, consumed in Tasks 10 and 14.

**4. Review Focus coverage.** Each focus item names its task.

**5. Plan proportion.** 26 tasks (0–24 plus 7b). Code appears only as design-level signatures; the logic is in the tests.

**6. Revision checks (review round 2):**
- **No nested `GuildQueue` calls.**
  - Enqueuers are only `requestRebuild`, `requestRecoveryReconcile`, `requestReferencedRolePrune`, `onMemberEvent`, `onTopLevelMessage` and `PolicyService` mutations.
  - Inside tasks, only `…InQueue` methods, DB transactions and non-blocking hand-offs (`markDirty`, `backfillQueue.enqueue`, timer scheduling) run.
  - `GuildQueue` throws `NestedGuildQueueError` on same-guild re-entry, with tests in Tasks 10, 12 and 18.
- **Role deletion is one database transaction.** `RoleDeletionStore.apply` (Task 7b) covers both live and offline pruning. The trigger-injected rollback test proves atomicity.
- **No unsupported product limits.** The policy-count limit is removed. `/autotrack list` paginates instead (a component constraint). The only limits left are D8 and the manual cap of 25.
- **Every repository method has a caller.** The caller tables are in Tasks 6 and 7. `pruneRole`, `deleteRoleTrackingSources` and `anonymizeActor` are removed. Actor anonymization lives inside `repo.forgetUser`.
- **Every lifecycle cleanup is wired.** `deleteChannelPolicies` and `purgeGuild` run through `TrackingService` lifecycle hooks (Task 20), regardless of flags, with tests in `lifecycle-cleanup.test.ts`.
- **Named indexes and tests agree.** The exact 17-name set is asserted in Task 5: 7 recreated + 4 untouched + 6 new.
- **No global constraint contradicts a later task.**
  - Constraint 6 now allows snapshot mention-id inspection for E5 overlap only, as Task 13 needs.
  - Constraint 11 no longer invents a commit trailer.
  - Constraint 13 matches Tasks 18/19.
- **Coalescing can't lose the last transition.** `runKeyed` merges only while pending, and gives exactly one trailing rerun when dirtied while running. The A→B test is in Task 10.
- **Selected-channel permissions use verified Discord data:** `data.resolved.channels[id].app_permissions` (official Resolved Data Structure and the 2026-07-16 changelog; typed optional in discord-api-types 0.38.55). Absent means no warning and no REST call.
- **M8 still blocks Task 1.** Task 0 is unchanged, and Global Constraint 1 still applies.
- **Spec fidelity fix.** The DB-failure retry in the recovery reconcile is index-only (`requestRecoveryReconcile`), matching §9.2. It no longer re-enumerates members.

**7. Approval note (non-blocking): the in-memory index must shrink.**
- `MemberRoleIndex.setReferencedRoles` discards unreferenced roles and members (Task 9).
- The shrink runs inline after role deletions and policy decreases (Tasks 15, 18), and periodically on the sweeper tick (Task 20) for stopped or expired trackings.
- No new product behaviour and no persistence. `activeMessageRoleIds` gives the rebuilder and the prune their message-role input.

**Planning finding — a genuine design gap, resolved without a product change:**
- The spec decides policy eligibility by channel type (D4). But a gateway `MESSAGE_CREATE` carries no parent id, and the reconciler has only the tracking row.
- Resolution: store the `channel_type` the candidate already has on the tracking row, as a nullable column in the same 0002 rebuild.
- Product behaviour is unchanged. Only persistence is added, and it is flagged here for the reviewer.
