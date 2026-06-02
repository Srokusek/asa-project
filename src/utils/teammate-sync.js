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

function normalizeMeta(meta, fallbackReason) {
  const input = isPlainObject(meta) ? meta : {};
  return {
    reason: String(input.reason ?? fallbackReason),
    sourceChatId: Number(input.sourceChatId ?? 0) || null
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

const teammateSyncHandlers = [
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
