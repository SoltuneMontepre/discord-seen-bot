import type { Kysely } from "kysely";
import { GatewayHealth } from "./app/gateway-health.ts";
import type { Clock, DiscordPort, Logger } from "./app/ports.ts";
import { Reconciler } from "./app/reconciler.ts";
import { RenderScheduler } from "./app/render-scheduler.ts";
import { deleteUnfinishedStarts } from "./app/startup-recovery.ts";
import { Sweeper } from "./app/sweeper.ts";
import { TrackingService } from "./app/tracking-service.ts";
import { migrateToLatest } from "./db/migrator.ts";
import { Repository } from "./db/repository.ts";
import type { Database } from "./db/schema.ts";
import { attachGateway, type GatewayLike } from "./discord/gateway.ts";
import type { Responder } from "./discord/interactions/responder.ts";
import { InteractionRouter } from "./discord/interactions/router.ts";
import { cardRenderer } from "./discord/render/card.ts";
import type { Policy } from "./domain/policy.ts";

export interface BotOptions {
  db: Kysely<Database>;
  port: DiscordPort;
  responder: Responder;
  /** Created only after startup recovery has run (so no interaction can arrive earlier). */
  createGateway: () => GatewayLike;
  applicationId: string;
  policy: Policy;
  logger: Logger;
  clock: Clock;
  debugPayloads?: boolean;
}

export interface Bot {
  repo: Repository;
  service: TrackingService;
  scheduler: RenderScheduler;
  health: GatewayHealth;
  reconciler: Reconciler;
  router: InteractionRouter;
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
  });

  let gateway: GatewayLike | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;

  return {
    repo,
    service,
    scheduler,
    health,
    reconciler,
    router,
    async start() {
      const applied = await migrateToLatest(o.db);
      if (applied.length > 0) o.logger.info({ applied }, "migrations applied");
      // Before the gateway connects → before any interaction can be accepted.
      await deleteUnfinishedStarts(repo, o.logger);
      await sweeper.runOnce();
      gateway = o.createGateway();
      attachGateway(gateway, { health, reconciler, service, router, logger: o.logger });
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
