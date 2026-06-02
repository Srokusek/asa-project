export const MISSION_TYPES = Object.freeze({
  GOTO_TILE: "GOTO_TILE",
  ANSWER_CHAT: "ANSWER_CHAT",
  CALCULATE_EXPRESSION: "CALCULATE_EXPRESSION",
  PICKUP_AT_TILE: "PICKUP_AT_TILE",
  DELIVER_AT_TILE: "DELIVER_AT_TILE",
  DROP_ON_TILE: "DROP_ON_TILE",
  FORBIDDEN_TILE: "FORBIDDEN_TILE",
  PICKUP_TILE_MULTIPLIER: "PICKUP_TILE_MULTIPLIER",
  DELIVERY_TILE_MULTIPLIER: "DELIVERY_TILE_MULTIPLIER",
  DELIVERY_COUNT_MULTIPLIER: "DELIVERY_COUNT_MULTIPLIER",
  STACK_EXACTLY_N: "STACK_EXACTLY_N",
  STACK_COUNT_MULTIPLIER: "STACK_COUNT_MULTIPLIER",
  PARCEL_VALUE_FILTER: "PARCEL_VALUE_FILTER",
  AVOID_RED: "AVOID_RED",
  PREFER_RED: "PREFER_RED",
  RENDEZVOUS: "RENDEZVOUS",
  HANDOFF: "HANDOFF",
  DUAL_AGENT_DELIVERY: "DUAL_AGENT_DELIVERY",
  RED_LIGHT_GREEN_LIGHT: "RED_LIGHT_GREEN_LIGHT",
  BOTH_NEAR_POSITION: "BOTH_NEAR_POSITION",
  SPLIT_ROLES: "SPLIT_ROLES",
  COORDINATED_WAIT: "COORDINATED_WAIT",
  COORDINATED_SCOUT: "COORDINATED_SCOUT"
});

export const MISSION_LEVELS = Object.freeze({
  LEVEL_1: 1,
  LEVEL_2: 2,
  LEVEL_3: 3
});

export const MISSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ACCEPTED: "ACCEPTED",
  DEFERRED: "DEFERRED",
  REJECTED: "REJECTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED"
});

const LEVEL_1_TYPES = new Set([
  MISSION_TYPES.GOTO_TILE,
  MISSION_TYPES.ANSWER_CHAT,
  MISSION_TYPES.CALCULATE_EXPRESSION,
  MISSION_TYPES.PICKUP_AT_TILE,
  MISSION_TYPES.DELIVER_AT_TILE,
  MISSION_TYPES.DROP_ON_TILE
]);

const LEVEL_2_TYPES = new Set([
  MISSION_TYPES.FORBIDDEN_TILE,
  MISSION_TYPES.PICKUP_TILE_MULTIPLIER,
  MISSION_TYPES.DELIVERY_TILE_MULTIPLIER,
  MISSION_TYPES.DELIVERY_COUNT_MULTIPLIER,
  MISSION_TYPES.STACK_EXACTLY_N,
  MISSION_TYPES.STACK_COUNT_MULTIPLIER,
  MISSION_TYPES.PARCEL_VALUE_FILTER,
  MISSION_TYPES.AVOID_RED,
  MISSION_TYPES.PREFER_RED
]);

const LEVEL_3_TYPES = new Set([
  MISSION_TYPES.RENDEZVOUS,
  MISSION_TYPES.HANDOFF,
  MISSION_TYPES.DUAL_AGENT_DELIVERY,
  MISSION_TYPES.RED_LIGHT_GREEN_LIGHT,
  MISSION_TYPES.BOTH_NEAR_POSITION,
  MISSION_TYPES.SPLIT_ROLES,
  MISSION_TYPES.COORDINATED_WAIT,
  MISSION_TYPES.COORDINATED_SCOUT
]);

const ACTIVE_STATUSES = new Set([MISSION_STATUS.ACTIVE, MISSION_STATUS.ACCEPTED, MISSION_STATUS.DEFERRED]);
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

function inferLevel(type, explicitLevel = null) {
  const n = Number(explicitLevel);
  if ([1, 2, 3].includes(n)) return n;
  if (LEVEL_1_TYPES.has(type)) return 1;
  if (LEVEL_2_TYPES.has(type)) return 2;
  if (LEVEL_3_TYPES.has(type)) return 3;
  return 1;
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

function asFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function priorityFor(input) {
  return asFiniteNumber(input.priority ?? input.objective?.priority, 0);
}

function stackCountFor(input) {
  const count = Math.round(Number(input.count ?? input.objective?.count));
  return Number.isFinite(count) && count > 0 ? count : null;
}

function stackMultiplierFor(input) {
  return asFiniteNumber(input.multiplier ?? input.objective?.multiplier, null);
}

function tileObjective(input) {
  const target = input?.target ?? input?.objective?.target ?? input?.objective?.position;
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
    const count = stackCountFor(input);
    if (count !== null) {
      const multiplier = stackMultiplierFor(input);
      return [{
        kind: "STACK_EXACTLY_N",
        count,
        hard: input.hard !== false,
        priority: priorityFor(input),
        ...(multiplier !== null ? { multiplier } : {})
      }];
    }
  }
  if (type === MISSION_TYPES.PARCEL_VALUE_FILTER) {
    return [{ kind: "PARCEL_VALUE_FILTER", ...copyObject(input.filter ?? input.objective?.filter) }];
  }
  if (type === MISSION_TYPES.AVOID_RED && target) {
    return [{ kind: "AVOID_RED", target, hard: input.hard !== false }];
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
  if (type === MISSION_TYPES.STACK_EXACTLY_N) {
    const count = stackCountFor(input);
    if (count !== null && Number.isFinite(multiplier)) {
      return [{ kind: "STACK_COUNT_MULTIPLIER", count, multiplier, priority: priorityFor(input) }];
    }
  }
  if (type === MISSION_TYPES.PREFER_RED && target) {
    return [{ kind: "PREFER_RED", target, multiplier: Number.isFinite(multiplier) ? multiplier : 1.5 }];
  }
  return [];
}

function normalizeConstraintsFor(input, type) {
  const constraints = asArray(input.constraints).map(copyObject);
  const defaults = constraints.length > 0 ? constraints : defaultConstraintsFor(input, type);
  if (type !== MISSION_TYPES.STACK_EXACTLY_N) return defaults;

  const count = stackCountFor(input);
  const multiplier = stackMultiplierFor(input);
  const priority = priorityFor(input);
  return defaults.map((constraint) => {
    const kind = String(constraint.kind ?? constraint.type ?? "").toUpperCase();
    if (kind !== "STACK_EXACTLY_N") return constraint;
    return {
      ...constraint,
      ...(constraint.count === undefined && count !== null ? { count } : {}),
      ...(constraint.multiplier === undefined && multiplier !== null ? { multiplier } : {}),
      ...(constraint.priority === undefined ? { priority } : {})
    };
  });
}

function normalizeRewardModifiersFor(input, type) {
  const modifiers = asArray(input.rewardModifiers).map(copyObject);
  const defaults = modifiers.length > 0 ? modifiers : defaultRewardModifiersFor(input, type);
  if (type !== MISSION_TYPES.STACK_EXACTLY_N) return defaults;

  const count = stackCountFor(input);
  const multiplier = stackMultiplierFor(input);
  if (count === null || multiplier === null) return defaults;
  const hasStackMultiplier = defaults.some((modifier) => {
    const kind = String(modifier.kind ?? modifier.type ?? "").toUpperCase();
    return ["STACK_COUNT_MULTIPLIER", "DELIVERY_COUNT_MULTIPLIER"].includes(kind) &&
      Math.round(Number(modifier.count)) === count;
  });
  if (hasStackMultiplier) return defaults;
  return [...defaults, { kind: "STACK_COUNT_MULTIPLIER", count, multiplier, priority: priorityFor(input) }];
}

export function validateMissionSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, reason: "invalid_spec" };
  if (!spec.id) return { ok: false, reason: "missing_id" };
  if (!Object.values(MISSION_TYPES).includes(spec.type)) return { ok: false, reason: "invalid_type" };
  if (!Object.values(MISSION_STATUS).includes(spec.status)) return { ok: false, reason: "invalid_status" };
  if (![1, 2, 3].includes(Number(spec.level))) return { ok: false, reason: "invalid_level" };

  if (
    [
      MISSION_TYPES.GOTO_TILE,
      MISSION_TYPES.PICKUP_AT_TILE,
      MISSION_TYPES.DELIVER_AT_TILE,
      MISSION_TYPES.DROP_ON_TILE,
      MISSION_TYPES.FORBIDDEN_TILE,
      MISSION_TYPES.PICKUP_TILE_MULTIPLIER,
      MISSION_TYPES.DELIVERY_TILE_MULTIPLIER,
      MISSION_TYPES.RENDEZVOUS,
      MISSION_TYPES.BOTH_NEAR_POSITION
    ].includes(spec.type) &&
    !tileObjective(spec)
  ) {
    return { ok: false, reason: "missing_target" };
  }

  if ([MISSION_TYPES.STACK_EXACTLY_N, MISSION_TYPES.DELIVERY_COUNT_MULTIPLIER, MISSION_TYPES.STACK_COUNT_MULTIPLIER].includes(spec.type)) {
    const count = Math.round(Number(spec.objective?.count ?? spec.constraints?.[0]?.count ?? spec.rewardModifiers?.[0]?.count));
    if (!Number.isFinite(count) || count < 1) return { ok: false, reason: "invalid_count" };
  }

  if (Number(spec.level) === 3 && spec.requiresCoordination !== true) {
    return { ok: false, reason: "level3_requires_coordination" };
  }

  return { ok: true };
}

export function createMissionSpec(input = {}) {
  const type = normalizeType(input.type);
  const createdAtTick = Number.isFinite(Number(input.createdAtTick)) ? Number(input.createdAtTick) : 0;
  const target = tileObjective(input);
  const objective = copyObject(input.objective, target ? { target } : {});
  const stackCount = stackCountFor(input);
  const stackMultiplier = stackMultiplierFor(input);
  if (type === MISSION_TYPES.STACK_EXACTLY_N && stackCount !== null && objective.count === undefined) {
    objective.count = stackCount;
  }
  if (type === MISSION_TYPES.STACK_EXACTLY_N && stackMultiplier !== null && objective.multiplier === undefined) {
    objective.multiplier = stackMultiplier;
  }
  const level = inferLevel(type, input.level);

  const spec = {
    id: String(input.id ?? nextMissionId(type)),
    sourceMessageId: input.sourceMessageId ?? input.sourceChatId ?? null,
    sourceChatId: Number(input.sourceChatId ?? 0) || null,
    sourceAgentId: input.sourceAgentId ?? input.senderId ?? null,
    createdBy: input.createdBy ?? input.sourceAgentId ?? "unknown",
    type,
    level,
    status: normalizeStatus(input.status),
    objective,
    constraints: normalizeConstraintsFor(input, type),
    rewardModifiers: normalizeRewardModifiersFor(input, type),
    expiresAtTick:
      input.expiresAtTick === null || input.expiresAtTick === undefined
        ? null
        : Number(input.expiresAtTick),
    persistent: Boolean(input.persistent),
    requiresCoordination: Boolean(input.requiresCoordination ?? level === 3),
    requiresPddl: Boolean(input.requiresPddl),
    macroPlan: input.macroPlan ?? null,
    assignedTo: input.assignedTo ?? null,
    createdAtTick,
    priority: priorityFor(input),
    reason: String(input.reason ?? objective.reason ?? "mission_spec")
  };

  const validation = validateMissionSpec(spec);
  return validation.ok ? spec : { ...spec, validationError: validation.reason };
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
