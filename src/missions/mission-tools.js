import { MISSION_TYPES, createMissionSpec } from "./mission-spec.js";

function currentTick(beliefs) {
  return Number(beliefs?.time ?? 0);
}

function addMission(beliefs, spec) {
  if (beliefs?.missionRegistry?.addMission) {
    return beliefs.missionRegistry.addMission(spec);
  }
  return createMissionSpec(spec);
}

function expiryFromTicks(beliefs, expiresTicks, fallback = null) {
  const ttl = Number(expiresTicks ?? fallback);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return currentTick(beliefs) + ttl;
}

export function registerGotoTileMission(beliefs, planRequest, meta = {}) {
  const plans = [];
  const missions = [];
  for (const target of planRequest.targets ?? []) {
    const mission = addMission(beliefs, {
      type: MISSION_TYPES.GOTO_TILE,
      sourceChatId: meta.sourceChatId,
      sourceAgentId: meta.senderId,
      objective: {
        target,
        priority: planRequest.priority,
        goalType: planRequest.goalType
      },
      expiresAtTick: expiryFromTicks(beliefs, planRequest.expiresTicks),
      reason: planRequest.reason
    });
    missions.push(mission);
    const plan = beliefs.pushManualTask?.({
      type: "goto_tile",
      sourceChatId: meta.sourceChatId,
      senderId: meta.senderId,
      expiresTicks: planRequest.expiresTicks,
      priority: planRequest.priority,
      payload: {
        target,
        reason: planRequest.reason,
        goalType: planRequest.goalType,
        missionId: mission.id
      }
    });
    if (plan) plans.push(plan);
  }
  return { missions, plans };
}

export function registerForbiddenTileMission(beliefs, request, meta = {}) {
  const mission = addMission(beliefs, {
    type: MISSION_TYPES.FORBIDDEN_TILE,
    sourceChatId: meta.sourceChatId,
    sourceAgentId: meta.senderId,
    target: request.target,
    objective: { target: request.target },
    constraints: [{ kind: "FORBIDDEN_TILE", target: request.target, hard: true }],
    persistent: true,
    reason: request.reason
  });
  const forbiddenTile = beliefs.setForbiddenTile?.(request.target, {
    reason: request.reason,
    sourceChatId: meta.sourceChatId,
    senderId: meta.senderId,
    missionId: mission.id
  });
  return { mission, forbiddenTile };
}

export function registerPickupTileMultiplierMission(beliefs, request, meta = {}) {
  const mission = addMission(beliefs, {
    type: MISSION_TYPES.PICKUP_TILE_MULTIPLIER,
    sourceChatId: meta.sourceChatId,
    sourceAgentId: meta.senderId,
    target: request.target,
    multiplier: request.multiplier,
    objective: { target: request.target, multiplier: request.multiplier },
    rewardModifiers: [{ kind: "PICKUP_TILE_MULTIPLIER", target: request.target, multiplier: request.multiplier }],
    persistent: true,
    reason: request.reason
  });
  const pickupMultiplierRule = beliefs.setPickupTileMultiplier?.(request.target, request.multiplier, {
    reason: request.reason,
    sourceChatId: meta.sourceChatId,
    senderId: meta.senderId,
    missionId: mission.id
  });
  return { mission, pickupMultiplierRule };
}

export function registerDeliveryTileMultiplierMission(beliefs, request, meta = {}) {
  const mission = addMission(beliefs, {
    type: MISSION_TYPES.DELIVERY_TILE_MULTIPLIER,
    sourceChatId: meta.sourceChatId,
    sourceAgentId: meta.senderId,
    target: request.target,
    multiplier: request.multiplier,
    objective: { target: request.target, multiplier: request.multiplier },
    rewardModifiers: [{ kind: "DELIVERY_TILE_MULTIPLIER", target: request.target, multiplier: request.multiplier }],
    persistent: true,
    reason: request.reason
  });
  const deliveryMultiplierRule = beliefs.setDeliveryTileMultiplier?.(request.target, request.multiplier, {
    reason: request.reason,
    sourceChatId: meta.sourceChatId,
    senderId: meta.senderId,
    missionId: mission.id
  });
  return { mission, deliveryMultiplierRule };
}

export function registerDeliveryCountMultiplierMission(beliefs, request, meta = {}) {
  const mission = addMission(beliefs, {
    type: MISSION_TYPES.DELIVERY_COUNT_MULTIPLIER,
    sourceChatId: meta.sourceChatId,
    sourceAgentId: meta.senderId,
    count: request.count,
    multiplier: request.multiplier,
    objective: { count: request.count, multiplier: request.multiplier },
    rewardModifiers: [{ kind: "DELIVERY_COUNT_MULTIPLIER", count: request.count, multiplier: request.multiplier }],
    persistent: true,
    reason: request.reason
  });
  const deliveryCountMultiplierRule = beliefs.setDeliveryCountMultiplier?.(request.count, request.multiplier, {
    reason: request.reason,
    sourceChatId: meta.sourceChatId,
    senderId: meta.senderId,
    missionId: mission.id
  });
  return { mission, deliveryCountMultiplierRule };
}
