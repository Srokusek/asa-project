export const TEAM_PROTOCOL = "ASA_TEAM_V1";

export const TEAM_MESSAGE_TYPES = Object.freeze({
  MISSION_SPEC: "MISSION_SPEC",
  MISSION_CANCEL: "MISSION_CANCEL",
  MISSION_UPDATE: "MISSION_UPDATE",
  MISSION_ACCEPTED: "MISSION_ACCEPTED",
  MISSION_REJECTED: "MISSION_REJECTED",
  MISSION_COMPLETED: "MISSION_COMPLETED",
  MISSION_FAILED: "MISSION_FAILED",
  COORDINATION_PLAN: "COORDINATION_PLAN",
  SUBGOAL_ASSIGNMENT: "SUBGOAL_ASSIGNMENT",
  TASK_CLAIM: "TASK_CLAIM",
  TASK_RELEASE: "TASK_RELEASE",
  POSITION_HEARTBEAT: "POSITION_HEARTBEAT",
  STATUS_UPDATE: "STATUS_UPDATE",
  HELP_REQUEST: "HELP_REQUEST",
  RENDEZVOUS_REQUEST: "RENDEZVOUS_REQUEST",
  RENDEZVOUS_ACK: "RENDEZVOUS_ACK",
  RENDEZVOUS_READY: "RENDEZVOUS_READY",
  HANDOFF_REQUEST: "HANDOFF_REQUEST",
  HANDOFF_READY: "HANDOFF_READY",
  HANDOFF_DONE: "HANDOFF_DONE",
  RED_LIGHT: "RED_LIGHT",
  GREEN_LIGHT: "GREEN_LIGHT",
  WAIT_UNTIL: "WAIT_UNTIL",
  RESUME: "RESUME",
  PATH_BLOCKED: "PATH_BLOCKED",
  TRAFFIC_ALERT: "TRAFFIC_ALERT"
});

let teamMessageSequence = 0;
const MAX_PAYLOAD_BYTES = 4096;

function nextMessageId(type = "MSG") {
  teamMessageSequence += 1;
  return `team_${String(type).toLowerCase()}_${Date.now()}_${teamMessageSequence}`;
}

function normalizeType(type) {
  const candidate = String(type ?? "").trim().toUpperCase();
  return TEAM_MESSAGE_TYPES[candidate] ?? candidate;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finitePosition(value) {
  const position = value?.position ?? value?.target ?? value;
  if (!isPlainObject(position)) return false;
  return Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y));
}

function payloadSizeOk(payload) {
  try {
    return JSON.stringify(payload ?? {}).length <= MAX_PAYLOAD_BYTES;
  } catch (_error) {
    return false;
  }
}

function missionSpecPayload(payload) {
  return payload?.missionSpec ?? payload?.spec ?? payload;
}

function coordinationPlanPayload(payload) {
  return payload?.coordinationPlan ?? payload?.plan ?? payload;
}

function subgoalPayload(payload) {
  return payload?.subgoal ?? payload?.goal ?? payload;
}

function validateMissionSpecPayload(payload) {
  const spec = missionSpecPayload(payload);
  if (!isPlainObject(spec)) return { ok: false, reason: "invalid_mission_spec_payload" };
  if (!spec.type) return { ok: false, reason: "missing_mission_spec_type" };
  return { ok: true };
}

function validateCoordinationPlanPayload(payload) {
  const plan = coordinationPlanPayload(payload);
  if (!isPlainObject(plan)) return { ok: false, reason: "invalid_coordination_plan_payload" };
  if (!plan.id && !plan.missionId) return { ok: false, reason: "missing_coordination_plan_id" };
  if (!isPlainObject(plan.roles)) return { ok: false, reason: "missing_coordination_plan_roles" };
  if (!Array.isArray(plan.phases)) return { ok: false, reason: "missing_coordination_plan_phases" };
  return { ok: true };
}

function validateSubgoalAssignmentPayload(payload) {
  const subgoal = subgoalPayload(payload);
  if (!isPlainObject(subgoal)) return { ok: false, reason: "invalid_subgoal_payload" };
  if (!subgoal.type && !subgoal.kind) return { ok: false, reason: "missing_subgoal_type" };
  return { ok: true };
}

function validatePayloadByType(type, payload) {
  if (!payloadSizeOk(payload)) return { ok: false, reason: "payload_too_large" };

  if (type === TEAM_MESSAGE_TYPES.MISSION_SPEC) return validateMissionSpecPayload(payload);
  if (type === TEAM_MESSAGE_TYPES.COORDINATION_PLAN) return validateCoordinationPlanPayload(payload);
  if (type === TEAM_MESSAGE_TYPES.SUBGOAL_ASSIGNMENT) return validateSubgoalAssignmentPayload(payload);
  if (type === TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT) {
    if (!payload.agentId && !payload.agentName) return { ok: false, reason: "missing_heartbeat_agent" };
    if (!payload.role) return { ok: false, reason: "missing_heartbeat_role" };
    if (!finitePosition(payload?.position ?? payload)) return { ok: false, reason: "invalid_position_payload" };
    if (!Number.isFinite(Number(payload.carriedCount))) return { ok: false, reason: "invalid_carried_count" };
    if (!Number.isFinite(Number(payload.tick))) return { ok: false, reason: "invalid_heartbeat_tick" };
    return { ok: true };
  }
  if (type === TEAM_MESSAGE_TYPES.STATUS_UPDATE) {
    return payload.status ? { ok: true } : { ok: false, reason: "missing_status" };
  }
  if (type === TEAM_MESSAGE_TYPES.RENDEZVOUS_READY) {
    return finitePosition(payload.position) ? { ok: true } : { ok: false, reason: "invalid_rendezvous_position" };
  }
  if (type === TEAM_MESSAGE_TYPES.MISSION_COMPLETED) {
    return payload.missionId || payload.id ? { ok: true } : { ok: false, reason: "missing_mission_id" };
  }
  if (type === TEAM_MESSAGE_TYPES.MISSION_FAILED) {
    if (!payload.missionId && !payload.id) return { ok: false, reason: "missing_mission_id" };
    return payload.reason ? { ok: true } : { ok: false, reason: "missing_failure_reason" };
  }

  return { ok: true };
}

export function validateTeamMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, reason: "invalid_message" };
  }
  if (message.protocol !== TEAM_PROTOCOL) return { ok: false, reason: "invalid_protocol" };
  if (!message.id) return { ok: false, reason: "missing_id" };
  if (!Object.values(TEAM_MESSAGE_TYPES).includes(message.type)) return { ok: false, reason: "invalid_type" };
  if (message.from === undefined || message.from === null) return { ok: false, reason: "missing_from" };
  if (!Number.isFinite(Number(message.tick))) return { ok: false, reason: "invalid_tick" };
  if (!Number.isFinite(Number(message.ttl))) return { ok: false, reason: "invalid_ttl" };
  if (message.payload === undefined || message.payload === null || typeof message.payload !== "object") {
    return { ok: false, reason: "invalid_payload" };
  }
  return validatePayloadByType(message.type, message.payload);
}

export function createTeamMessage(type, from, to = null, payload = {}, options = {}) {
  const normalizedType = normalizeType(type);
  const message = {
    protocol: TEAM_PROTOCOL,
    id: String(options.id ?? nextMessageId(normalizedType)),
    type: normalizedType,
    from: from ?? null,
    to: to ?? null,
    tick: Number(options.tick ?? 0) || 0,
    ttl: Number(options.ttl ?? 10) || 0,
    payload: payload ?? {}
  };

  const validation = validateTeamMessage(message);
  if (!validation.ok) {
    throw new Error(`invalid team message: ${validation.reason}`);
  }
  return message;
}

export function buildTeamMessage(input = {}) {
  return createTeamMessage(input.type, input.from, input.to ?? null, input.payload ?? {}, {
    id: input.id,
    tick: input.tick,
    ttl: input.ttl
  });
}

export function serializeTeamMessage(message) {
  const normalized = message?.protocol === TEAM_PROTOCOL
    ? message
    : buildTeamMessage(message);
  const validation = validateTeamMessage(normalized);
  if (!validation.ok) {
    throw new Error(`invalid team message: ${validation.reason}`);
  }
  return JSON.stringify(normalized);
}

export const stringifyTeamMessage = serializeTeamMessage;

export function parseTeamMessage(rawText) {
  try {
    const parsed = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
    if (!parsed || parsed.protocol !== TEAM_PROTOCOL) return null;
    const normalized = {
      protocol: TEAM_PROTOCOL,
      id: String(parsed.id ?? nextMessageId(parsed.type)),
      type: normalizeType(parsed.type),
      from: parsed.from ?? null,
      to: parsed.to ?? null,
      tick: Number(parsed.tick) || 0,
      ttl: Number(parsed.ttl) || 0,
      payload: parsed.payload ?? {}
    };
    const validation = validateTeamMessage(normalized);
    return validation.ok ? normalized : null;
  } catch (_error) {
    return null;
  }
}

export function hasTeamProtocolEnvelope(rawText) {
  try {
    const parsed = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
    return parsed?.protocol === TEAM_PROTOCOL;
  } catch (_error) {
    return false;
  }
}

export function isTeamMessage(rawText) {
  return parseTeamMessage(rawText) !== null;
}

export function isExpired(message, currentTick) {
  const parsed = parseTeamMessage(message) ?? message;
  if (!parsed) return true;
  if (Number(parsed.ttl) <= 0) return false;
  return Number(currentTick) > Number(parsed.tick) + Number(parsed.ttl);
}
