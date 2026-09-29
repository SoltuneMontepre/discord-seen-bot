import type { Kysely } from "kysely";
import { AutoTrackCoordinator } from "./app/auto-track-coordinator.ts";
import { BackfillQueue } from "./app/backfill-queue.ts";
import { ConfigAuthorizer } from "./app/config-authorizer.ts";
import { ExplicitUserResolver } from "./app/explicit-user-resolver.ts";
import { GatewayHealth } from "./app/gateway-health.ts";
import { GuildAutoTrackHealth } from "./app/guild-auto-track-health.ts";
import { GuildQueue } from "./app/guild-queue.ts";
import { MemberRoleIndex } from "./app/member-role-index.ts";
import { MemberStateRebuilder } from "./app/member-state-rebuilder.ts";
import { PolicyService } from "./app/policy-service.ts";
import type { Clock, DiscordPort, Logger } from "./app/ports.ts";
import { Reconciler } from "./app/reconciler.ts";
import { RenderScheduler } from "./app/render-scheduler.ts";
import { RoleSourceResolver } from "./app/role-source-resolver.ts";
import {
  deleteUnfinishedStarts,
  stopRoleDependentAutoTrackingsWhenDisabled,
} from "./app/startup-recovery.ts";
import { Sweeper } from "./app/sweeper.ts";
import { TargetReconciler } from "./app/target-reconciler.ts";
import { TargetResolverRegistry } from "./app/target-resolution.ts";
import { TrackingService } from "./app/tracking-service.ts";
import { migrateToLatest } from "./db/migrator.ts";
import { PolicyRepository } from "./db/policy-repository.ts";
import { Repository } from "./db/repository.ts";
import { RoleDeletionStore } from "./db/role-deletion.ts";
import type { Database } from "./db/schema.ts";
import { attachGateway, type GatewayLike } from "./discord/gateway.ts";
import { assertAllowedIntents, buildIntents } from "./discord/intents.ts";
import type { Responder } from "./discord/interactions/responder.ts";
import { InteractionRouter } from "./discord/interactions/router.ts";
import { cardRenderer } from "./discord/render/card.ts";
import type { Policy } from "./domain/policy.ts";

export interface Features {
  mentionAutoTrack: boolean;
  roleTargets: boolean;
}

export interface BotOptions {
  db: Kysely<Database>;
  port: DiscordPort;
  responder: Responder;
  /**
   * Created only after startup recovery has run (so no interaction can arrive earlier), with the
   * flag-derived gateway intents (already checked by assertAllowedIntents).
   */
  createGateway: (intents: number) => GatewayLike;
  applicationId: string;
  policy: Policy;
  logger: Logger;
  clock: Clock;
  debugPayloads?: boolean;
  /** M9 feature flags; both off (default) reproduces M0–M7 exactly. */
  features?: Features;
  /** Unrecoverable condition (4014). main.ts exits non-zero. */
  onFatal?: (reason: string) => void;
}

/** The M9 graph (exposed for diagnostics and tests). Role-state parts exist only with roleTargets. */
export interface M9Graph {
  features: Features;
  policies: PolicyRepository;
  queue: GuildQueue;
  backfillQueue: BackfillQueue;
  targetReconciler: TargetReconciler;
  coordinator: AutoTrackCoordinator | undefined;
  autoHealth: GuildAutoTrackHealth | undefined;
  index: MemberRoleIndex | undefined;
  rebuilder: MemberStateRebuilder | undefined;
  policyService: PolicyService | undefined;
}

export interface Bot {
  repo: Repository;
  service: TrackingService;
  scheduler: RenderScheduler;
  health: GatewayHealth;
  reconciler: Reconciler;
  router: InteractionRouter;
  m9: M9Graph;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Composition root. Startup order follows the plan (§12). */
export function createBot(o: BotOptions): Bot {
  const repo = new Repository(o.db);
  const scheduler = new RenderScheduler({
    repo,
    renderer: cardRenderer,
    port: o.port,
    clock: o.clock,
    policy: o.policy,
    logger: o.logger,
  });
  const service = new TrackingService({
    repo,
    port: o.port,
    renderer: cardRenderer,
    scheduler,
    clock: o.clock,
    policy: o.policy,
    logger: o.logger,
  });
  const health = new GatewayHealth(o.clock, repo, o.policy.heartbeatAckStaleMs, o.logger);
  const reconciler = new Reconciler({
    repo,
    port: o.port,
    service,
    scheduler,
    health,
    clock: o.clock,
    policy: o.policy,
    logger: o.logger,
  });
  service.hooks = {
    onMessageSignalFailed: () => reconciler.requestGapRecovery(),
    onReactionSignalFailed: (sourceId) => reconciler.scheduleReactionPass(sourceId),
  };
  const sweeper = new Sweeper({
    repo,
    service,
    clock: o.clock,
    policy: o.policy,
    logger: o.logger,
  });
  const m9 = createM9Graph(o, { repo, service, scheduler, reconciler });
  sweeper.afterTick = () => {
    const { coordinator, index } = m9;
    if (!coordinator || !index) return;
    for (const guildId of index.guildIds()) coordinator.requestReferencedRolePrune(guildId);
  };
  const router = new InteractionRouter({
    service,
    repo,
    scheduler,
    reconciler,
    port: o.port,
    responder: o.responder,
    applicationId: o.applicationId,
    policy: o.policy,
    logger: o.logger,
    debugPayloads: o.debugPayloads ?? false,
    autotrack: {
      features: m9.features,
      policies: m9.policies,
      ...(m9.policyService ? { policyService: m9.policyService } : {}),
    },
  });
  const intents = buildIntents(m9.features);
  assertAllowedIntents(intents, m9.features);

  let gateway: GatewayLike | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;

  return {
    repo,
    service,
    scheduler,
    health,
    reconciler,
    router,
    m9,
    async start() {
      const applied = await migrateToLatest(o.db);
      if (applied.length > 0) o.logger.info({ applied }, "migrations applied");
      // Before the gateway connects → before any interaction can be accepted.
      await deleteUnfinishedStarts(repo, o.logger);
      if (!m9.features.roleTargets) {
        const stopped = await stopRoleDependentAutoTrackingsWhenDisabled(
          repo,
          o.logger,
          o.clock.now(),
        );
        for (const id of stopped) scheduler.markDirty(id);
      }
      await sweeper.runOnce();
      o.logger.info({ intents, features: m9.features }, "gateway intents");
      gateway = o.createGateway(intents);
      attachGateway(gateway, {
        health,
        reconciler,
        service,
        router,
        logger: o.logger,
        ...(m9.coordinator
          ? { autoTrack: { coordinator: m9.coordinator, features: m9.features } }
          : {}),
        ...(o.onFatal ? { onFatal: o.onFatal } : {}),
      });
      ticker = setInterval(() => {
        health.tick().catch((err: unknown) => o.logger.error({ err }, "watermark tick failed"));
      }, o.policy.watermarkTickMs);
      sweeper.start();
      await gateway.connect();
      o.logger.info({}, "bot started");
    },
    async stop() {
      router.accepting = false;
      reconciler.dispose();
      m9.rebuilder?.dispose();
      m9.autoHealth?.dispose();
      m9.backfillQueue.dispose();
      sweeper.stop();
      if (ticker) clearInterval(ticker);
      await scheduler.flushAll(5_000);
      // Only a healthy gateway with no pending gap recovery may advance the watermark.
      await health
        .tick()
        .catch((err: unknown) => o.logger.error({ err }, "final watermark tick failed"));
      await gateway?.destroy();
      o.logger.info({}, "bot stopped");
    },
  };
}

/**
 * M9 wiring (spec §4): the coordinator when either flag is on; health, index, role resolver,
 * rebuilder and PolicyService only when role targets are on. Policy lifecycle cleanup is wired
 * regardless of flags (policies may remain from an earlier role-enabled period).
 */
function createM9Graph(
  o: BotOptions,
  core: {
    repo: Repository;
    service: TrackingService;
    scheduler: RenderScheduler;
    reconciler: Reconciler;
  },
): M9Graph {
  const features = o.features ?? { mentionAutoTrack: false, roleTargets: false };
  const roles = features.roleTargets;
  const policies = new PolicyRepository(o.db);
  const queue = new GuildQueue();
  const index = roles ? new MemberRoleIndex() : undefined;
  let rebuilder: MemberStateRebuilder | undefined;
  const autoHealth = roles
    ? new GuildAutoTrackHealth({
        clock: o.clock,
        policy: o.policy,
        onPauseNoticeDue: (g) => {
          rebuilder
            ?.refreshRoleDependentCards(g)
            .catch((err: unknown) =>
              o.logger.warn({ guildId: g, err }, "pause notice refresh failed"),
            );
        },
        logger: o.logger,
      })
    : undefined;
  const registry = new TargetResolverRegistry();
  registry.register(new ExplicitUserResolver());
  if (index) registry.register(new RoleSourceResolver(index));
  const backfillQueue = new BackfillQueue({
    backfill: (id, users) => core.reconciler.backfillTargets(id, users),
    concurrency: o.policy.backfillConcurrency,
    logger: o.logger,
  });
  const targetReconciler = new TargetReconciler({
    features,
    repo: core.repo,
    policies,
    registry,
    health: autoHealth,
    queue,
    scheduler: core.scheduler,
    backfill: backfillQueue,
    policy: o.policy,
    clock: o.clock,
    logger: o.logger,
  });
  if (autoHealth) {
    const pause = (t: Parameters<TargetReconciler["pauseNoticeApplies"]>[0]) =>
      targetReconciler.pauseNoticeApplies(t);
    core.scheduler.pauseProvider = pause;
    core.service.pauseProvider = pause;
  }
  if (index && autoHealth) {
    rebuilder = new MemberStateRebuilder({
      port: o.port,
      policies,
      repo: core.repo,
      roleDeletion: new RoleDeletionStore(o.db),
      index,
      health: autoHealth,
      queue,
      reconciler: targetReconciler,
      scheduler: core.scheduler,
      policy: o.policy,
      clock: o.clock,
      logger: o.logger,
    });
  }
  const coordinator =
    features.mentionAutoTrack || roles
      ? new AutoTrackCoordinator({
          features,
          repo: core.repo,
          policies,
          registry,
          health: autoHealth,
          index,
          rebuilder,
          roleDeletion: new RoleDeletionStore(o.db),
          reconciler: targetReconciler,
          queue,
          service: core.service,
          backfill: core.reconciler,
          policy: o.policy,
          clock: o.clock,
          logger: o.logger,
        })
      : undefined;
  const policyService =
    rebuilder && index && autoHealth && coordinator
      ? new PolicyService({
          policies,
          authorizer: new ConfigAuthorizer(),
          registry,
          index,
          health: autoHealth,
          queue,
          rebuilder,
          reconciler: targetReconciler,
          coordinator,
          policy: o.policy,
          clock: o.clock,
          logger: o.logger,
        })
      : undefined;
  core.service.lifecycle = {
    async onChannelDeleted(channelId) {
      const n = await policies.deleteChannelPolicies(channelId);
      if (n > 0) o.logger.info({ channelId, policies: n }, "channel deleted; its policies removed");
    },
    async onGuildRemoved(guildId) {
      await policies.purgeGuild(guildId);
      await coordinator?.onMemberEvent({ t: "guild_removed", guildId });
    },
  };
  return {
    features,
    policies,
    queue,
    backfillQueue,
    targetReconciler,
    coordinator,
    autoHealth,
    index,
    rebuilder,
    policyService,
  };
}
