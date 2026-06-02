import { hasTeamProtocolEnvelope, isExpired, parseTeamMessage, TEAM_MESSAGE_TYPES } from "./team-protocol.js";

const REPLY_TYPES = new Set([
  TEAM_MESSAGE_TYPES.MISSION_ACCEPTED,
  TEAM_MESSAGE_TYPES.MISSION_REJECTED,
  TEAM_MESSAGE_TYPES.MISSION_COMPLETED,
  TEAM_MESSAGE_TYPES.MISSION_FAILED,
  TEAM_MESSAGE_TYPES.STATUS_UPDATE,
  TEAM_MESSAGE_TYPES.RENDEZVOUS_ACK,
  TEAM_MESSAGE_TYPES.RENDEZVOUS_READY,
  TEAM_MESSAGE_TYPES.HANDOFF_READY,
  TEAM_MESSAGE_TYPES.HANDOFF_DONE
]);

function senderId(message) {
  return message.fromId ?? message.id ?? message.from ?? null;
}

function messageText(message) {
  return String(message.text ?? message.msg ?? message.message ?? "");
}

export function normalizeAlias(value) {
  const alias = String(value ?? "").trim().toLowerCase();
  return alias || null;
}

function uniqueAliases(values = []) {
  return [...new Set(values.map(normalizeAlias).filter(Boolean))];
}

function aliasesForRole(role) {
  const normalizedRole = normalizeAlias(role);
  if (normalizedRole === "llm") return ["llm", "llm-agent", "coordination-agent"];
  if (normalizedRole === "bdi") return ["bdi", "bdi-agent", "standard-bdi-agent"];
  return normalizedRole ? [normalizedRole] : [];
}

function aliasCursorKey(aliases) {
  return uniqueAliases(aliases).sort().join("|") || "default";
}

function addressedToAlias(message, aliases) {
  if (message.to === null || message.to === undefined) return true;
  return uniqueAliases(aliases).includes(normalizeAlias(message.to));
}

function sentByAlias(message, aliases) {
  return uniqueAliases(aliases).includes(normalizeAlias(message.from));
}

export function buildAgentAliases({ me = null, config = {}, role = null } = {}) {
  const agentRole = role ?? config.agentRole;
  return uniqueAliases([
    me?.id,
    me?.name,
    config.agentName,
    config.agentRole,
    ...aliasesForRole(agentRole)
  ]);
}

export class MessageRouter {
  constructor({ selfId = null, role = "bdi", aliases = [] } = {}) {
    this.selfId = selfId;
    this.role = role;
    this.selfAliases = uniqueAliases([selfId, role, ...aliases, ...aliasesForRole(role)]);
    this.teamInbox = [];
    this.missionInbox = [];
    this.teamReplyInbox = [];
    this.cursorByAgent = new Map();
    this.replyCursor = 0;
    this.missionCursor = 0;
    this.seenTeamMessageIds = new Set();
  }

  setSelfId(selfId) {
    this.selfId = selfId ?? this.selfId;
    this.selfAliases = uniqueAliases([this.selfId, ...this.selfAliases]);
  }

  setAliases(aliases = []) {
    this.selfAliases = uniqueAliases([this.selfId, this.role, ...aliases, ...aliasesForRole(this.role)]);
    return this.selfAliases;
  }

  routeIncomingChat(message, currentTick = 0) {
    const text = messageText(message);
    const teamMessage = parseTeamMessage(text);
    if (teamMessage) {
      return this.routeTeamMessage(teamMessage, currentTick);
    }
    if (hasTeamProtocolEnvelope(text)) {
      return this.routeTeamMessage(text, currentTick);
    }

    const entry = {
      ...message,
      fromId: senderId(message),
      text,
      receivedAtTick: currentTick
    };
    this.missionInbox.push(entry);
    return { kind: "mission_text", message: entry };
  }

  routeTeamMessage(message, currentTick = 0) {
    const parsed = parseTeamMessage(message);
    if (!parsed || isExpired(parsed, currentTick)) return { kind: "ignored", reason: "invalid_or_expired" };
    if (this.seenTeamMessageIds.has(parsed.id)) return { kind: "ignored", reason: "duplicate_team_message" };
    if (parsed.from && sentByAlias(parsed, this.selfAliases)) {
      return { kind: "ignored", reason: "self_message" };
    }
    this.seenTeamMessageIds.add(parsed.id);
    this.teamInbox.push(parsed);
    if (REPLY_TYPES.has(parsed.type)) this.teamReplyInbox.push(parsed);
    return { kind: "team", message: parsed };
  }

  consumeTeamMessagesFor(agentId = this.selfId, currentTick = Infinity) {
    return this.consumeTeamMessagesForAliases([agentId], currentTick);
  }

  consumeTeamMessagesForAliases(aliases = this.selfAliases, currentTick = Infinity) {
    const effectiveAliases = uniqueAliases(Array.isArray(aliases) ? aliases : [aliases]);
    const key = aliasCursorKey(effectiveAliases);
    const start = this.cursorByAgent.get(key) ?? 0;
    const messages = this.teamInbox
      .slice(start)
      .filter((message) => !isExpired(message, currentTick))
      .filter((message) => !sentByAlias(message, effectiveAliases))
      .filter((message) => addressedToAlias(message, effectiveAliases));
    this.cursorByAgent.set(key, this.teamInbox.length);
    return messages;
  }

  consumeMissionMessages() {
    const messages = this.missionInbox.slice(this.missionCursor);
    this.missionCursor = this.missionInbox.length;
    return messages;
  }

  consumeTeamReplies(currentTick = Infinity) {
    const messages = this.teamReplyInbox
      .slice(this.replyCursor)
      .filter((message) => !isExpired(message, currentTick));
    this.replyCursor = this.teamReplyInbox.length;
    return messages;
  }
}

export function createMessageRouter(options = {}) {
  return new MessageRouter(options);
}
