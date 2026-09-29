import { isValidEvidence, type ValidityContext } from "./evidence-validity.ts";
import {
  type Ack,
  type AckState,
  DIRECT_KINDS,
  type Evidence,
  type EvidenceKind,
  type ProjectionRow,
  STATE_ORDER,
  type Target,
  WEAK_KINDS,
} from "./types.ts";

export interface ProjectionInput {
  targets: readonly Target[];
  evidence: readonly Evidence[];
  acks: readonly Ack[];
  tracked: ValidityContext;
}

const KIND_ORDER: Record<EvidenceKind, number> = {
  DIRECT_REPLY: 0,
  DIRECT_REACTION: 1,
  TYPING_AFTER: 2,
  CHANNEL_MESSAGE_AFTER: 3,
};

/**
 * Basis within a tier: earliest non-null occurredAt; if none has one (reactions only), the earliest
 * observedAt, keeping occurredAt = null so no fake time is ever rendered.
 */
function pickBasis(rows: Evidence[]): Evidence | undefined {
  return [...rows].sort((a, b) => {
    if (a.occurredAt !== null && b.occurredAt !== null && a.occurredAt !== b.occurredAt)
      return a.occurredAt - b.occurredAt;
    if (a.occurredAt !== null && b.occurredAt === null) return -1;
    if (a.occurredAt === null && b.occurredAt !== null) return 1;
    if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0;
  })[0];
}

/** Pure 4-state rules engine. Precedence CONFIRMED > INTERACTED > LIKELY > UNKNOWN. */
export function project(input: ProjectionInput): ProjectionRow[] {
  const targets = [...input.targets].sort((a, b) =>
    a.addedAt !== b.addedAt ? a.addedAt - b.addedAt : a.userId < b.userId ? -1 : 1,
  );
  const acks = new Map(input.acks.map((a) => [a.userId, a]));
  const byUser = new Map<string, Evidence[]>();
  for (const e of input.evidence) {
    const list = byUser.get(e.userId);
    if (list) list.push(e);
    else byUser.set(e.userId, [e]);
  }

  const rows: (ProjectionRow & { order: number })[] = targets.map((target, order) => {
    const ack = acks.get(target.userId);
    if (ack && ack.revokedAt === null) {
      return {
        userId: target.userId,
        state: "CONFIRMED",
        basis: { kind: "EXPLICIT_ACK", occurredAt: ack.acknowledgedAt },
        order,
      };
    }
    const valid = (byUser.get(target.userId) ?? []).filter((e) =>
      isValidEvidence(e, target.addedAt, input.tracked),
    );
    const tiers: [AckState, Evidence[]][] = [
      ["INTERACTED", valid.filter((e) => DIRECT_KINDS.has(e.kind))],
      ["LIKELY", valid.filter((e) => WEAK_KINDS.has(e.kind))],
    ];
    for (const [state, list] of tiers) {
      const basis = pickBasis(list);
      if (basis) {
        return {
          userId: target.userId,
          state,
          basis: { kind: basis.kind, occurredAt: basis.occurredAt },
          order,
        };
      }
    }
    return { userId: target.userId, state: "UNKNOWN", basis: null, order };
  });

  return rows
    .sort(
      (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.order - b.order,
    )
    .map(({ order: _order, ...row }) => row);
}
