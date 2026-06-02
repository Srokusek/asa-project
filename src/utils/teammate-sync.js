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

function normalizeMeta(meta, fallbackReason) {
  const input = isPlainObject(meta) ? meta : {};
  return {
    reason: String(input.reason ?? fallbackReason),
    sourceChatId: Number(input.sourceChatId ?? 0) || null
  };
}

function createTileMultiplierSyncConfig({ defaultReason, apply }) {
  return {
    build(entry) {
      const target = parseTarget(entry);
      const multiplier = parsePositiveMultiplier(entry?.multiplier);
      if (!target || multiplier === null) return null;
      return {
        payload: { target, multiplier },
        meta: normalizeMeta(entry, defaultReason)
      };
    },
    parse(message) {
      const target = parseTarget(message?.payload?.target);
      const multiplier = parsePositiveMultiplier(message?.payload?.multiplier);
      if (!target || multiplier === null) return null;
      return {
        type: String(message.type),
        payload: { target, multiplier },
        meta: normalizeMeta(message.meta, defaultReason)
      };
    },
    apply(parsed, context) {
      apply(parsed.payload.target, parsed.payload.multiplier, {
        reason: parsed.meta.reason,
        sourceChatId: parsed.meta.sourceChatId,
        senderId: context.fromId ?? null
      }, context.beliefs);
      return true;
    }
  };
}

const teammateSyncRegistry = {
  pickup_tile_multiplier_set: createTileMultiplierSyncConfig({
    defaultReason: "pickup_tile_multiplier_teammate_sync",
    apply(target, multiplier, meta, beliefs) {
      beliefs.setPickupTileMultiplier(target, multiplier, meta);
    }
  }),
  delivery_tile_multiplier_set: createTileMultiplierSyncConfig({
    defaultReason: "delivery_tile_multiplier_teammate_sync",
    apply(target, multiplier, meta, beliefs) {
      beliefs.setDeliveryTileMultiplier(target, multiplier, meta);
    }
  })
};

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
