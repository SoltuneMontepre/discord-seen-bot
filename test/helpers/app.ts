import { GatewayHealth } from "../../src/app/gateway-health.ts";
import type { Clock, Logger } from "../../src/app/ports.ts";
import { Reconciler } from "../../src/app/reconciler.ts";
import { RenderScheduler } from "../../src/app/render-scheduler.ts";
import { Sweeper } from "../../src/app/sweeper.ts";
import { TrackingService } from "../../src/app/tracking-service.ts";
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
