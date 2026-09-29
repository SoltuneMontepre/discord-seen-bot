import { AutoTrackCoordinator } from "../../src/app/auto-track-coordinator.ts";
import { BackfillQueue } from "../../src/app/backfill-queue.ts";
import { ConfigAuthorizer } from "../../src/app/config-authorizer.ts";
import { ExplicitUserResolver } from "../../src/app/explicit-user-resolver.ts";
import { GatewayHealth } from "../../src/app/gateway-health.ts";
import { GuildAutoTrackHealth } from "../../src/app/guild-auto-track-health.ts";
import { GuildQueue } from "../../src/app/guild-queue.ts";
import { MemberRoleIndex } from "../../src/app/member-role-index.ts";
import { MemberStateRebuilder } from "../../src/app/member-state-rebuilder.ts";
import { PolicyService } from "../../src/app/policy-service.ts";
import type { Clock, Logger } from "../../src/app/ports.ts";
import { Reconciler } from "../../src/app/reconciler.ts";
import { RenderScheduler } from "../../src/app/render-scheduler.ts";
import { RoleSourceResolver } from "../../src/app/role-source-resolver.ts";
import { Sweeper } from "../../src/app/sweeper.ts";
import { TargetReconciler } from "../../src/app/target-reconciler.ts";
import { TargetResolverRegistry } from "../../src/app/target-resolution.ts";
import { TrackingService } from "../../src/app/tracking-service.ts";
import { PolicyRepository } from "../../src/db/policy-repository.ts";
import { RoleDeletionStore } from "../../src/db/role-deletion.ts";
import { cardRenderer } from "../../src/discord/render/card.ts";
import { DEFAULT_POLICY, type Policy } from "../../src/domain/policy.ts";
import { createTestDb } from "./db.ts";
import { FakeDiscord } from "./fake-discord.ts";

export interface LogEntry {
  level: string;
  obj: object;
  msg: string | undefined;
}

export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at = (level: string) => (obj: object, msg?: string) => entries.push({ level, obj, msg });
  return { entries, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** Clock that follows Date.now() (works with vi fake timers / setSystemTime). */
export const dateClock: Clock = { now: () => Date.now() };

export async function createApp(
  opts: { dbPath?: string; policy?: Partial<Policy>; discord?: FakeDiscord } = {},
) {
  const db = await createTestDb(opts.dbPath);
  const discord = opts.discord ?? new FakeDiscord();
  const logger = memoryLogger();
  const policy: Policy = { ...DEFAULT_POLICY, ...opts.policy };
  const clock = dateClock;
  const scheduler = new RenderScheduler({
    repo: db.repo,
    renderer: cardRenderer,
    port: discord,
    clock,
    policy,
    logger,
  });
  const service = new TrackingService({
    repo: db.repo,
    port: discord,
    renderer: cardRenderer,
    scheduler,
    clock,
    policy,
    logger,
  });
  const health = new GatewayHealth(clock, db.repo, policy.heartbeatAckStaleMs, logger);
  const reconciler = new Reconciler({
    repo: db.repo,
    port: discord,
    service,
    scheduler,
    health,
    clock,
    policy,
    logger,
  });
  service.hooks = {
    onMessageSignalFailed: () => reconciler.requestGapRecovery(),
    onReactionSignalFailed: (id) => reconciler.scheduleReactionPass(id),
  };
  const sweeper = new Sweeper({ repo: db.repo, service, clock, policy, logger });
  return {
    ...db,
    discord,
    logger,
    policy,
    clock,
    scheduler,
    service,
    health,
    reconciler,
    sweeper,
    async dispose() {
      reconciler.dispose();
      sweeper.stop();
      await scheduler.flushAll(0);
      await db.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createApp>>;

// ------------------------------------------------------------------ M9 graph

export interface AutoAppOptions {
  features: { mentionAutoTrack: boolean; roleTargets: boolean };
  policy?: Partial<Policy>;
  dbPath?: string;
  discord?: FakeDiscord;
}

/**
 * createApp + the M9 auto-track graph, wired like createBot: the coordinator when either flag is
 * on; health, index, role resolver and rebuilder only when role targets are on.
 */
export async function createAutoApp(opts: AutoAppOptions) {
  const app = await createApp({
    ...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
    ...(opts.discord ? { discord: opts.discord } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  const roles = opts.features.roleTargets;
  const policies = new PolicyRepository(app.db);
  const queue = new GuildQueue();
  const index = roles ? new MemberRoleIndex() : undefined;
  let rebuilder: MemberStateRebuilder | undefined;
  const autoHealth = roles
    ? new GuildAutoTrackHealth({
        clock: app.clock,
        policy: app.policy,
        onPauseNoticeDue: (g) => void rebuilder?.refreshRoleDependentCards(g),
        logger: app.logger,
      })
    : undefined;
  const registry = new TargetResolverRegistry();
  registry.register(new ExplicitUserResolver());
  if (index) registry.register(new RoleSourceResolver(index));
  const backfillQueue = new BackfillQueue({
    backfill: (id, users) => app.reconciler.backfillTargets(id, users),
    concurrency: app.policy.backfillConcurrency,
    logger: app.logger,
  });
  const targetReconciler = new TargetReconciler({
    features: opts.features,
    repo: app.repo,
    policies,
    registry,
    health: autoHealth,
    queue,
    scheduler: app.scheduler,
    backfill: backfillQueue,
    policy: app.policy,
    clock: app.clock,
    logger: app.logger,
  });
  if (autoHealth) {
    const pause = (t: Parameters<typeof targetReconciler.pauseNoticeApplies>[0]) =>
      targetReconciler.pauseNoticeApplies(t);
    app.scheduler.pauseProvider = pause;
    app.service.pauseProvider = pause;
  }
  if (roles && index && autoHealth) {
    rebuilder = new MemberStateRebuilder({
      port: app.discord,
      policies,
      repo: app.repo,
      roleDeletion: new RoleDeletionStore(app.db),
      index,
      health: autoHealth,
      queue,
      reconciler: targetReconciler,
      scheduler: app.scheduler,
      policy: app.policy,
      clock: app.clock,
      logger: app.logger,
    });
  }
  const coordinator = new AutoTrackCoordinator({
    features: opts.features,
    repo: app.repo,
    policies,
    registry,
    health: autoHealth,
    index,
    rebuilder,
    roleDeletion: new RoleDeletionStore(app.db),
    reconciler: targetReconciler,
    queue,
    service: app.service,
    backfill: app.reconciler,
    policy: app.policy,
    clock: app.clock,
    logger: app.logger,
  });
  const authorizer = new ConfigAuthorizer();
  const policyService =
    rebuilder && index && autoHealth
      ? new PolicyService({
          policies,
          authorizer,
          registry,
          index,
          health: autoHealth,
          queue,
          rebuilder,
          reconciler: targetReconciler,
          coordinator,
          policy: app.policy,
          clock: app.clock,
          logger: app.logger,
        })
      : undefined;
  return {
    ...app,
    features: opts.features,
    authorizer,
    policyService,
    policies,
    queue,
    index,
    /** M9 member-state health (app.health stays the gateway health). */
    autoHealth,
    registry,
    backfillQueue,
    targetReconciler,
    rebuilder,
    coordinator,
    /** Waits for every task queued so far for the guild. */
    settle: (guildId: string) => queue.run(guildId, async () => {}),
    async dispose() {
      rebuilder?.dispose();
      autoHealth?.dispose();
      backfillQueue.dispose();
      await app.dispose();
    },
  };
}

export type AutoApp = Awaited<ReturnType<typeof createAutoApp>>;
