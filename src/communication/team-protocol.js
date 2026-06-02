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

function nextMessageId(type = "MSG") {
  teamMessageSequence += 1;
  return `team_${String(type).toLowerCase()}_${Date.now()}_${teamMessageSequence}`;
}

function normalizeType(type) {
  const candidate = String(type ?? "").trim().toUpperCase();
  return TEAM_MESSAGE_TYPES[candidate] ?? candidate;
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
  return { ok: true };
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

export function isTeamMessage(rawText) {
  return parseTeamMessage(rawText) !== null;
}

export function isExpired(message, currentTick) {
  const parsed = parseTeamMessage(message) ?? message;
  if (!parsed) return true;
  if (Number(parsed.ttl) <= 0) return false;
  return Number(currentTick) > Number(parsed.tick) + Number(parsed.ttl);
}
