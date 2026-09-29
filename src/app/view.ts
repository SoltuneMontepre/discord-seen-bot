import type { TrackingView } from "../db/repository.ts";
import { project } from "../domain/projection.ts";
import type { ProjectionRow } from "../domain/types.ts";

export function projectView(view: TrackingView): ProjectionRow[] {
  return project({
    targets: view.targets,
    evidence: view.evidence,
    acks: view.acks,
    tracked: {
      sourceCreatedAt: view.tracked.sourceCreatedAt,
      createdAt: view.tracked.createdAt,
      weakWindowEndsAt: view.tracked.weakWindowEndsAt,
    },
  });
}
