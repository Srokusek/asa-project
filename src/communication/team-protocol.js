export const TEAM_PROTOCOL = "ASA_TEAM_V1";

export const TEAM_MESSAGE_TYPES = Object.freeze({
  MISSION_SPEC: "MISSION_SPEC",
  MISSION_ACCEPTED: "MISSION_ACCEPTED",
  MISSION_REJECTED: "MISSION_REJECTED",
  TASK_CLAIM: "TASK_CLAIM",
  TASK_RELEASE: "TASK_RELEASE",
  POSITION_HEARTBEAT: "POSITION_HEARTBEAT",
  HELP_REQUEST: "HELP_REQUEST",
  RENDEZVOUS_REQUEST: "RENDEZVOUS_REQUEST",
  RENDEZVOUS_ACK: "RENDEZVOUS_ACK",
  PATH_BLOCKED: "PATH_BLOCKED"
});

export function buildTeamMessage({ type, from, to = null, tick = 0, ttl = 10, payload = {} } = {}) {
  const normalizedType = String(type ?? "").toUpperCase();
  if (!TEAM_MESSAGE_TYPES[normalizedType] && !Object.values(TEAM_MESSAGE_TYPES).includes(normalizedType)) {
    throw new Error(`unknown team message type: ${type}`);
  }
  return {
    protocol: TEAM_PROTOCOL,
    type: TEAM_MESSAGE_TYPES[normalizedType] ?? normalizedType,
    from: from ?? null,
    to,
    tick: Number(tick) || 0,
    ttl: Number(ttl) || 0,
    payload: payload ?? {}
  };
}

export function stringifyTeamMessage(message) {
  return JSON.stringify(buildTeamMessage(message));
}

export function parseTeamMessage(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || parsed.protocol !== TEAM_PROTOCOL) return null;
    if (!Object.values(TEAM_MESSAGE_TYPES).includes(parsed.type)) return null;
    return {
      protocol: TEAM_PROTOCOL,
      type: parsed.type,
      from: parsed.from ?? null,
      to: parsed.to ?? null,
      tick: Number(parsed.tick) || 0,
      ttl: Number(parsed.ttl) || 0,
      payload: parsed.payload ?? {}
    };
  } catch (_error) {
    return null;
  }
}

export function isTeamMessage(raw) {
  return parseTeamMessage(raw) !== null;
}
