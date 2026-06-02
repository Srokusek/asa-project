import { createTeamMessage, TEAM_MESSAGE_TYPES } from "./team-protocol.js";

function compactTask(task = null) {
  if (!task) return null;
  return {
    id: task.id ?? null,
    type: task.type ?? null,
    priority: task.priority ?? null,
    missionId: task.payload?.missionId ?? null,
    target: task.payload?.target ?? null,
    reason: task.payload?.reason ?? null
  };
}

export function buildPositionHeartbeatPayload({ beliefs, config } = {}) {
  if (!beliefs?.me) return null;
  const task = beliefs.peekManualTask?.() ?? beliefs.manualTasks?.[0] ?? null;
  return {
    agentId: beliefs.me.id ?? null,
    agentName: config?.agentName ?? beliefs.me.name ?? null,
    role: config?.agentRole ?? null,
    position: { x: Math.round(Number(beliefs.me.x)), y: Math.round(Number(beliefs.me.y)) },
    score: Number(beliefs.me.score ?? 0),
    carriedCount: Number(beliefs.carriedParcels?.size ?? 0),
    currentTask: compactTask(task),
    ready: Boolean(beliefs.ready),
    tick: Number(beliefs.time ?? 0)
  };
}

export function createPositionHeartbeatMessage({ beliefs, config, to = null } = {}) {
  const payload = buildPositionHeartbeatPayload({ beliefs, config });
  if (!payload) return null;
  const heartbeatTicks = Math.max(1, Number(config?.team?.heartbeatTicks ?? 5) || 5);
  const ttl = Math.max(1, Number(config?.team?.heartbeatTtlTicks ?? heartbeatTicks * 3) || heartbeatTicks * 3);
  return createTeamMessage(
    TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT,
    config?.agentName ?? payload.agentId,
    to,
    payload,
    { tick: Number(beliefs?.time ?? payload.tick ?? 0), ttl }
  );
}

export function heartbeatDue(lastSentTick, currentTick, config = {}) {
  if (!Number.isFinite(Number(currentTick))) return false;
  const heartbeatTicks = Math.max(1, Number(config.team?.heartbeatTicks ?? 5) || 5);
  return Number(currentTick) - Number(lastSentTick ?? -Infinity) >= heartbeatTicks;
}
