export const MISSION_TYPES = Object.freeze({
  GOTO_TILE: "GOTO_TILE",
  FORBIDDEN_TILE: "FORBIDDEN_TILE",
  PICKUP_TILE_MULTIPLIER: "PICKUP_TILE_MULTIPLIER",
  DELIVERY_TILE_MULTIPLIER: "DELIVERY_TILE_MULTIPLIER",
  DELIVERY_COUNT_MULTIPLIER: "DELIVERY_COUNT_MULTIPLIER",
  STACK_EXACTLY_N: "STACK_EXACTLY_N",
  STACK_COUNT_MULTIPLIER: "STACK_COUNT_MULTIPLIER",
  PARCEL_VALUE_FILTER: "PARCEL_VALUE_FILTER",
  RENDEZVOUS: "RENDEZVOUS",
  HANDOFF: "HANDOFF",
  RED_LIGHT_GREEN_LIGHT: "RED_LIGHT_GREEN_LIGHT",
  ANSWER_CHAT: "ANSWER_CHAT"
});

export const MISSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ACCEPTED: "ACCEPTED",
  DEFERRED: "DEFERRED",
  REJECTED: "REJECTED",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED"
});

const ACTIVE_STATUSES = new Set([MISSION_STATUS.ACTIVE, MISSION_STATUS.ACCEPTED]);
let sequence = 0;

function nextMissionId(type) {
  sequence += 1;
  return `mission_${String(type ?? "UNKNOWN").toLowerCase()}_${sequence}`;
}

function normalizeType(type) {
  const candidate = String(type ?? MISSION_TYPES.ANSWER_CHAT).trim().toUpperCase();
  return MISSION_TYPES[candidate] ?? candidate;
}

function normalizeStatus(status) {
  const candidate = String(status ?? MISSION_STATUS.ACTIVE).trim().toUpperCase();
  return MISSION_STATUS[candidate] ?? MISSION_STATUS.ACTIVE;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === undefined || value === null) return [];
  return [value];
}

function copyObject(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  return { ...value };
}

function tileObjective(input) {
  const target = input?.target ?? input?.objective?.target;
  if (!target) return null;
  const x = Math.round(Number(target.x));
  const y = Math.round(Number(target.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function defaultConstraintsFor(input, type) {
  const target = tileObjective(input);
  if (type === MISSION_TYPES.FORBIDDEN_TILE && target) {
    return [{ kind: "FORBIDDEN_TILE", target, hard: true }];
  }
  if (type === MISSION_TYPES.STACK_EXACTLY_N) {
    const count = Math.round(Number(input.count ?? input.objective?.count));
    if (Number.isFinite(count) && count > 0) {
      return [{ kind: "STACK_EXACTLY_N", count, hard: input.hard !== false }];
    }
  }
  if (type === MISSION_TYPES.PARCEL_VALUE_FILTER) {
    return [{ kind: "PARCEL_VALUE_FILTER", ...copyObject(input.filter ?? input.objective?.filter) }];
  }
  return [];
}

function defaultRewardModifiersFor(input, type) {
  const target = tileObjective(input);
  const multiplier = Number(input.multiplier ?? input.objective?.multiplier);
  if (type === MISSION_TYPES.PICKUP_TILE_MULTIPLIER && target && Number.isFinite(multiplier)) {
    return [{ kind: "PICKUP_TILE_MULTIPLIER", target, multiplier }];
  }
  if (type === MISSION_TYPES.DELIVERY_TILE_MULTIPLIER && target && Number.isFinite(multiplier)) {
    return [{ kind: "DELIVERY_TILE_MULTIPLIER", target, multiplier }];
  }
  if (type === MISSION_TYPES.DELIVERY_COUNT_MULTIPLIER) {
    const count = Math.round(Number(input.count ?? input.objective?.count));
    if (Number.isFinite(count) && count > 0 && Number.isFinite(multiplier)) {
      return [{ kind: "DELIVERY_COUNT_MULTIPLIER", count, multiplier }];
    }
  }
  if (type === MISSION_TYPES.STACK_COUNT_MULTIPLIER) {
    const count = Math.round(Number(input.count ?? input.objective?.count));
    if (Number.isFinite(count) && count > 0 && Number.isFinite(multiplier)) {
      return [{ kind: "STACK_COUNT_MULTIPLIER", count, multiplier }];
    }
  }
  return [];
}

export function createMissionSpec(input = {}) {
  const type = normalizeType(input.type);
  const createdAtTick = Number.isFinite(Number(input.createdAtTick)) ? Number(input.createdAtTick) : 0;
  const target = tileObjective(input);
  const objective = copyObject(input.objective, target ? { target } : {});
  const constraints = asArray(input.constraints);
  const rewardModifiers = asArray(input.rewardModifiers);

  return {
    id: String(input.id ?? nextMissionId(type)),
    sourceChatId: Number(input.sourceChatId ?? 0) || null,
    sourceAgentId: input.sourceAgentId ?? input.senderId ?? null,
    type,
    level: String(input.level ?? "normal"),
    status: normalizeStatus(input.status),
    objective,
    constraints: constraints.length > 0 ? constraints.map(copyObject) : defaultConstraintsFor(input, type),
    rewardModifiers:
      rewardModifiers.length > 0 ? rewardModifiers.map(copyObject) : defaultRewardModifiersFor(input, type),
    expiresAtTick:
      input.expiresAtTick === null || input.expiresAtTick === undefined
        ? null
        : Number(input.expiresAtTick),
    persistent: Boolean(input.persistent),
    requiresCoordination: Boolean(input.requiresCoordination),
    requiresPddl: Boolean(input.requiresPddl),
    createdAtTick,
    reason: String(input.reason ?? objective.reason ?? "mission_spec")
  };
}

export function missionIsActive(spec, currentTick = null) {
  if (!spec || !ACTIVE_STATUSES.has(spec.status)) return false;
  if (spec.persistent) return true;
  if (currentTick === null || spec.expiresAtTick === null || spec.expiresAtTick === undefined) return true;
  return Number(spec.expiresAtTick) > Number(currentTick);
}

export function missionShouldExpire(spec, currentTick) {
  if (!spec || spec.persistent) return false;
  if (spec.expiresAtTick === null || spec.expiresAtTick === undefined) return false;
  return ACTIVE_STATUSES.has(spec.status) && Number(spec.expiresAtTick) <= Number(currentTick);
}
