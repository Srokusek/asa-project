const TEAMMATE_SYNC_VERSION = 1;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTarget(target) {
  const x = Math.round(Number(target?.x));
  const y = Math.round(Number(target?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function parsePositiveMultiplier(multiplier) {
  const value = Number(multiplier);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function parseNonNegativeMultiplier(multiplier) {
  const value = Number(multiplier);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseSignedBonus(bonus) {
  const value = Number(bonus);
  if (!Number.isFinite(value)) return null;
  return value;
}

function parsePositiveCount(count) {
  const value = Math.round(Number(count));
  if (!Number.isFinite(value) || value < 1) return null;
  return value;
}

function parseNonNegativeInteger(value) {
  const normalized = Math.round(Number(value));
  if (!Number.isFinite(normalized) || normalized < 0) return null;
  return normalized;
}

function parseOrchestrationTiles(tiles) {
  if (!Array.isArray(tiles) || tiles.length === 0) return null;
  const normalized = [];
  const seen = new Set();
  for (const tile of tiles) {
    const target = parseTarget(tile);
    if (!target) return null;
    const key = `${target.x},${target.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(target);
  }
  return normalized.length > 0 ? normalized : null;
}

function parseOrchestrationRules(rules) {
  if (!Array.isArray(rules)) return null;
  const normalized = [];
  const ruleIds = new Set();
  for (const rule of rules) {
    if (!isPlainObject(rule)) return null;
    const id = String(rule.id ?? "").trim();
    const pickupPoiId = String(rule.pickupPoiId ?? "").trim();
    const dropoffPoiId = String(rule.dropoffPoiId ?? "").trim();
    const pickupTiles = parseOrchestrationTiles(rule.pickupTiles);
    const dropoffTiles = parseOrchestrationTiles(rule.dropoffTiles);
    if (!id || !pickupPoiId || !dropoffPoiId || !pickupTiles || !dropoffTiles) return null;
    if (ruleIds.has(id)) return null;
    ruleIds.add(id);
    normalized.push({
      id,
      pickupPoiId,
      dropoffPoiId,
      pickupTiles,
      dropoffTiles,
      ...(Object.hasOwn(rule, "priority") ? { priority: rule.priority } : {})
    });
  }
  return normalized;
}

function normalizeMeta(meta, fallbackReason) {
  const input = isPlainObject(meta) ? meta : {};
  return {
    reason: String(input.reason ?? fallbackReason),
    sourceChatId: Number(input.sourceChatId ?? 0) || null
  };
}

function parseManualTaskPayload(payload) {
  if (!isPlainObject(payload)) return null;
  const type = String(payload.type ?? "").trim();
  const priority = String(payload.priority ?? "").trim();
  const target = parseTarget(payload.payload?.target);
  if (!type || !priority || !target) return null;

  const kind = payload.payload?.kind === undefined ? null : String(payload.payload.kind);
  const taskKey = payload.payload?.taskKey === undefined ? null : String(payload.payload.taskKey);
  const waitAtTarget = payload.payload?.waitAtTarget === true;
  const maxDistance = payload.payload?.maxDistance === undefined ? null : parseNonNegativeInteger(payload.payload.maxDistance);
  const center = payload.payload?.center === undefined ? null : parseTarget(payload.payload.center);
  if (payload.payload?.maxDistance !== undefined && maxDistance === null) return null;
  if (payload.payload?.center !== undefined && !center) return null;

  return {
    type,
    priority,
    payload: {
      target,
      reason: String(payload.payload?.reason ?? "manual_task_teammate_sync"),
      goalType: String(payload.payload?.goalType ?? "goto_tile"),
      ...(kind ? { kind } : {}),
      ...(taskKey ? { taskKey } : {}),
      ...(waitAtTarget ? { waitAtTarget: true } : {}),
      ...(center ? { center } : {}),
      ...(maxDistance !== null ? { maxDistance } : {})
    }
  };
}

function createTileNumericSyncConfig({ type, field, defaultReason, parser, apply }) {
  return {
    type,
    build(entry) {
      const target = parseTarget(entry);
      const value = parser(entry?.[field]);
      if (!target || value === null) return null;
      return {
        payload: { target, [field]: value },
        meta: normalizeMeta(entry, defaultReason)
      };
    },
    parse(message) {
      const target = parseTarget(message?.payload?.target);
      const value = parser(message?.payload?.[field]);
      if (!target || value === null) return null;
      return {
        type,
        payload: { target, [field]: value },
        meta: normalizeMeta(message.meta, defaultReason)
      };
    },
    apply(parsed, context) {
      apply(parsed.payload.target, parsed.payload[field], {
        reason: parsed.meta.reason,
        sourceChatId: parsed.meta.sourceChatId,
        senderId: context.fromId ?? null
      }, context.beliefs);
      return true;
    }
  };
}

function createCountNumericSyncConfig({ type, field, defaultReason, parser, apply }) {
  return {
    type,
    build(entry) {
      const count = parsePositiveCount(entry?.count);
      const value = parser(entry?.[field]);
      if (count === null || value === null) return null;
      return {
        payload: { count, [field]: value },
        meta: normalizeMeta(entry, defaultReason)
      };
    },
    parse(message) {
      const count = parsePositiveCount(message?.payload?.count);
      const value = parser(message?.payload?.[field]);
      if (count === null || value === null) return null;
      return {
        type,
        payload: { count, [field]: value },
        meta: normalizeMeta(message.meta, defaultReason)
      };
    },
    apply(parsed, context) {
      apply(parsed.payload.count, parsed.payload[field], {
        reason: parsed.meta.reason,
        sourceChatId: parsed.meta.sourceChatId,
        senderId: context.fromId ?? null
      }, context.beliefs);
      return true;
    }
  };
}

function createManualTaskSyncConfig() {
  const type = "manual_task_set";
  const defaultReason = "manual_task_teammate_sync";
  return {
    type,
    build(entry) {
      const parsed = parseManualTaskPayload(entry);
      if (!parsed) return null;
      return {
        payload: parsed,
        meta: normalizeMeta(entry, defaultReason)
      };
    },
    parse(message) {
      const parsed = parseManualTaskPayload(message?.payload);
      if (!parsed) return null;
      return {
        type,
        payload: parsed,
        meta: normalizeMeta(message.meta, defaultReason)
      };
    },
    apply(parsed, context) {
      context.beliefs.pushManualTask({
        type: parsed.payload.type,
        sourceChatId: parsed.meta.sourceChatId,
        senderId: context.fromId ?? null,
        priority: parsed.payload.priority,
        payload: parsed.payload.payload
      });
      return true;
    }
  };
}

function createParcelTileTaskSyncConfig({ type, defaultReason, apply }) {
  return {
    type,
    build(entry) {
      const target = parseTarget(entry?.target ?? entry);
      if (!target) return null;
      return {
        payload: {
          target,
          reason: String(entry?.reason ?? defaultReason)
        },
        meta: normalizeMeta(entry, defaultReason)
      };
    },
    parse(message) {
      const target = parseTarget(message?.payload?.target);
      if (!target) return null;
      return {
        type,
        payload: {
          target,
          reason: String(message?.payload?.reason ?? defaultReason)
        },
        meta: normalizeMeta(message.meta, defaultReason)
      };
    },
    apply(parsed, context) {
      apply(parsed.payload.target, {
        reason: parsed.payload.reason,
        sourceChatId: parsed.meta.sourceChatId,
        senderId: context.fromId ?? null
      }, context.beliefs);
      return true;
    }
  };
}

function createOrchestrationRulesSyncConfig() {
  const type = "orchestration_rules_replace";
  const defaultReason = "orchestration_rules_teammate_sync";
  return {
    type,
    build(entry) {
      const rules = parseOrchestrationRules(entry?.rules);
      if (!rules) return null;
      return {
        payload: { rules },
        meta: normalizeMeta(entry, defaultReason)
      };
    },
    parse(message) {
      const rules = parseOrchestrationRules(message?.payload?.rules);
      if (!rules) return null;
      return {
        type,
        payload: { rules },
        meta: normalizeMeta(message.meta, defaultReason)
      };
    },
    apply(parsed, context) {
      try {
        context.beliefs.replaceOrchestrationRules(parsed.payload.rules);
        return true;
      } catch (error) {
        context.logger?.warn?.("orchestration teammate sync failed", {
          fromId: context.fromId ?? null,
          error: error.message
        });
        return false;
      }
    }
  };
}

const teammateSyncHandlers = [
  createManualTaskSyncConfig(),
  createOrchestrationRulesSyncConfig(),
  createParcelTileTaskSyncConfig({
    type: "set_pickup_tile",
    defaultReason: "pickup_tile_task_teammate_sync",
    apply(target, meta, beliefs) {
      beliefs.setPickupTileTask(target, meta);
    }
  }),
  createParcelTileTaskSyncConfig({
    type: "set_delivery_tile",
    defaultReason: "delivery_tile_task_teammate_sync",
    apply(target, meta, beliefs) {
      beliefs.setDeliveryTileTask(target, meta);
    }
  }),
  createTileNumericSyncConfig({
    type: "pickup_tile_multiplier_set",
    field: "multiplier",
    defaultReason: "pickup_tile_multiplier_teammate_sync",
    parser: parsePositiveMultiplier,
    apply(target, value, meta, beliefs) {
      beliefs.setPickupTileMultiplier(target, value, meta);
    }
  }),
  createTileNumericSyncConfig({
    type: "pickup_tile_bonus_set",
    field: "bonus",
    defaultReason: "pickup_tile_bonus_teammate_sync",
    parser: parseSignedBonus,
    apply(target, value, meta, beliefs) {
      beliefs.setPickupTileBonus(target, value, meta);
    }
  }),
  createTileNumericSyncConfig({
    type: "delivery_tile_multiplier_set",
    field: "multiplier",
    defaultReason: "delivery_tile_multiplier_teammate_sync",
    parser: parsePositiveMultiplier,
    apply(target, value, meta, beliefs) {
      beliefs.setDeliveryTileMultiplier(target, value, meta);
    }
  }),
  createTileNumericSyncConfig({
    type: "delivery_tile_bonus_set",
    field: "bonus",
    defaultReason: "delivery_tile_bonus_teammate_sync",
    parser: parseSignedBonus,
    apply(target, value, meta, beliefs) {
      beliefs.setDeliveryTileBonus(target, value, meta);
    }
  }),
  createCountNumericSyncConfig({
    type: "delivery_count_multiplier_set",
    field: "multiplier",
    defaultReason: "delivery_count_multiplier_teammate_sync",
    parser: parseNonNegativeMultiplier,
    apply(count, value, meta, beliefs) {
      beliefs.setDeliveryCountMultiplier(count, value, meta);
    }
  }),
  createCountNumericSyncConfig({
    type: "delivery_count_bonus_set",
    field: "bonus",
    defaultReason: "delivery_count_bonus_teammate_sync",
    parser: parseSignedBonus,
    apply(count, value, meta, beliefs) {
      beliefs.setDeliveryCountBonus(count, value, meta);
    }
  })
];

const teammateSyncRegistry = Object.fromEntries(teammateSyncHandlers.map((handler) => [handler.type, handler]));

function normalizeEnvelope(message) {
  if (!isPlainObject(message)) return null;
  if (Number(message.v) !== TEAMMATE_SYNC_VERSION) return null;
  const type = String(message.type ?? "").trim();
  if (!type) return null;
  if (!isPlainObject(message.payload)) return null;
  return {
    v: TEAMMATE_SYNC_VERSION,
    type,
    payload: message.payload,
    meta: normalizeMeta(message.meta, `${type}_teammate_sync`)
  };
}

export function buildTeammateSyncMessage({ type, entry }) {
  const handler = teammateSyncRegistry[String(type ?? "").trim()];
  if (!handler) return null;

  const built = handler.build(entry);
  if (!built) return null;

  return JSON.stringify({
    v: TEAMMATE_SYNC_VERSION,
    type: String(type),
    payload: built.payload,
    meta: built.meta
  });
}

export function parseTeammateSyncMessage(rawMessage) {
  try {
    const normalized = normalizeEnvelope(JSON.parse(String(rawMessage ?? "")));
    if (!normalized) return null;

    const handler = teammateSyncRegistry[normalized.type];
    if (!handler) return normalized;

    return handler.parse(normalized);
  } catch (_error) {
    return null;
  }
}

export function applyTeammateSyncMessage({ rawText, fromId, beliefs, logger }) {
  const parsed = parseTeammateSyncMessage(rawText);
  if (!parsed) return false;

  const handler = teammateSyncRegistry[parsed.type];
  if (!handler) {
    logger?.warn?.("unknown teammate sync type", {
      type: parsed.type,
      fromId: fromId ?? null
    });
    return false;
  }

  return handler.apply(parsed, { fromId, beliefs, logger });
}
