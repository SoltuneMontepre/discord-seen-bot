import type { APIInteraction } from "@discordjs/core";
import type { DiscordPort, Logger } from "../../app/ports.ts";
import type { Reconciler } from "../../app/reconciler.ts";
import type { RenderScheduler } from "../../app/render-scheduler.ts";
import type { TrackingService } from "../../app/tracking-service.ts";
import type { Repository } from "../../db/repository.ts";
import type { Policy } from "../../domain/policy.ts";
import type { Responder } from "./responder.ts";

export interface InteractionDeps {
  service: TrackingService;
  repo: Repository;
  scheduler: Pick<RenderScheduler, "renderNow" | "noteRendered">;
  reconciler: Pick<Reconciler, "initialBackfill" | "backfillTargets">;
  port: Pick<DiscordPort, "getMessage">;
  responder: Responder;
  applicationId: string;
  policy: Policy;
  logger: Logger;
  debugPayloads: boolean;
}

/** Identity always comes from the Discord interaction payload, never from custom_id. */
export function invokerId(i: APIInteraction): string | undefined {
  return i.member?.user.id ?? i.user?.id;
}

/** Fire-and-forget background work: never on the interaction latency path, failures logged. */
export function background(logger: Logger, what: string, work: () => Promise<unknown>): void {
  void work().catch((err: unknown) => logger.error({ err, what }, "background task failed"));
}
