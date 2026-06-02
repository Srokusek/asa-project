import { normalizeAlias } from "../communication/message-router.js";
import { TEAM_MESSAGE_TYPES } from "../communication/team-protocol.js";
import { createMissionSpec } from "./mission-spec.js";

const VALID_TEAM_MESSAGE_TYPES = new Set(Object.values(TEAM_MESSAGE_TYPES));

function normalizeType(value) {
  const candidate = String(value ?? "").trim().toUpperCase();
  return TEAM_MESSAGE_TYPES[candidate] ?? candidate;
}

function canonicalAlias(value, roleAliases = {}) {
  const normalized = normalizeAlias(value);
  if (!normalized) return value ?? null;
  for (const [canonical, aliases] of Object.entries(roleAliases ?? {})) {
    const candidates = [canonical, ...(Array.isArray(aliases) ? aliases : [aliases])].map(normalizeAlias).filter(Boolean);
    if (candidates.includes(normalized)) return canonical;
  }
  return normalized;
}

export function parseMissionSpecPayload(payload, meta = {}) {
  if (!payload) return null;
  if (typeof payload === "string") {
    try {
      return parseMissionSpecPayload(JSON.parse(payload), meta);
    } catch (_error) {
      return null;
    }
  }
  if (typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload.missionSpec ?? payload.spec ?? payload;
  if (!candidate.type) return null;
  return createMissionSpec({
    ...candidate,
    sourceChatId: candidate.sourceChatId ?? meta.sourceChatId,
    sourceAgentId: candidate.sourceAgentId ?? meta.sourceAgentId,
    sourceMessageId: candidate.sourceMessageId ?? meta.sourceMessageId,
    createdBy: candidate.createdBy ?? meta.createdBy,
    createdAtTick: candidate.createdAtTick ?? meta.createdAtTick
  });
}

function parseJsonPayload(payload) {
  if (!payload) return { ok: false, reason: "empty_output" };
  if (typeof payload === "object") return { ok: true, value: payload };
  try {
    return { ok: true, value: JSON.parse(String(payload)) };
  } catch (_error) {
    return { ok: false, reason: "invalid_json" };
  }
}

function normalizeMissionSpecs(value, meta = {}) {
  const rawSpecs = Array.isArray(value?.missionSpecs)
    ? value.missionSpecs
    : value?.missionSpec
      ? [value.missionSpec]
      : value?.type
        ? [value]
        : [];
  const missionSpecs = [];
  const rejectedMissionSpecs = [];
  for (const spec of rawSpecs) {
    const parsed = parseMissionSpecPayload(spec, meta);
    if (!parsed || parsed.validationError) {
      rejectedMissionSpecs.push({
        spec,
        reason: parsed?.validationError ?? "invalid_mission_spec"
      });
      continue;
    }
    missionSpecs.push(parsed);
  }
  return { missionSpecs, rejectedMissionSpecs };
}

function normalizeRoles(roles, roleAliases = {}) {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return null;
  return Object.fromEntries(
    Object.entries(roles)
      .map(([key, role]) => [canonicalAlias(key, roleAliases), role])
      .filter(([key, role]) => key && role && typeof role === "object" && !Array.isArray(role))
  );
}

function normalizeCoordinationPlans(value, options = {}) {
  const plans = Array.isArray(value?.coordinationPlans)
    ? value.coordinationPlans
    : value?.coordinationPlan
      ? [value.coordinationPlan]
      : value?.roles && value?.phases
        ? [value]
        : [];
  const normalized = [];
  const rejected = [];
  for (const plan of plans) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      rejected.push({ plan, reason: "invalid_coordination_plan" });
      continue;
    }
    const roles = normalizeRoles(plan.roles, options.roleAliases);
    if (!(plan.id || plan.missionId)) {
      rejected.push({ plan, reason: "missing_coordination_plan_id" });
      continue;
    }
    if (!roles || Object.keys(roles).length === 0) {
      rejected.push({ plan, reason: "missing_coordination_plan_roles" });
      continue;
    }
    if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
      rejected.push({ plan, reason: "missing_coordination_plan_phases" });
      continue;
    }
    normalized.push({
      ...plan,
      roles,
      messagesToSend: Array.isArray(plan.messagesToSend) ? plan.messagesToSend : [],
      fallbackPolicy: plan.fallbackPolicy ?? "continue_bdi",
      successConditions: Array.isArray(plan.successConditions) ? plan.successConditions : [],
      failureConditions: Array.isArray(plan.failureConditions) ? plan.failureConditions : [],
      ttl: Number.isFinite(Number(plan.ttl ?? plan.expiresTicks)) ? Number(plan.ttl ?? plan.expiresTicks) : 80
    });
  }
  return { coordinationPlans: normalized, rejectedCoordinationPlans: rejected };
}

function normalizeSubgoalAssignments(value, options = {}) {
  const assignments = Array.isArray(value?.subgoalAssignments)
    ? value.subgoalAssignments
    : value?.subgoalAssignment
      ? [value.subgoalAssignment]
      : [];
  return assignments
    .filter((assignment) => assignment && typeof assignment === "object")
    .map((assignment) => ({
      to: canonicalAlias(assignment.to ?? assignment.assignedTo ?? null, options.roleAliases),
      subgoal: assignment.subgoal ?? assignment.goal ?? assignment
    }))
    .filter((assignment) => assignment.subgoal && typeof assignment.subgoal === "object");
}

function normalizeTeamMessages(value, options = {}) {
  const messages = Array.isArray(value?.teamMessages)
    ? value.teamMessages
    : value?.teamMessage
      ? [value.teamMessage]
      : [];
  const normalized = [];
  const rejected = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      rejected.push({ message, reason: "invalid_team_message" });
      continue;
    }
    const type = normalizeType(message.type);
    if (!VALID_TEAM_MESSAGE_TYPES.has(type)) {
      rejected.push({ message, reason: "invalid_team_message_type" });
      continue;
    }
    normalized.push({
      ...message,
      type,
      to: canonicalAlias(message.to ?? null, options.roleAliases)
    });
  }
  return { teamMessages: normalized, rejectedTeamMessages: rejected };
}

export function parseLlmMissionOutput(payload, options = {}) {
  const parsed = parseJsonPayload(payload);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid_payload" };
  if (value.unsupported || value.impossible) {
    return {
      ok: true,
      value: {
        unsupported: true,
        reason: String(value.reason ?? "unsupported")
      }
    };
  }
  if (value.clarification) {
    return { ok: true, value: { clarification: String(value.clarification) } };
  }

  const { missionSpecs, rejectedMissionSpecs } = normalizeMissionSpecs(value, options.meta ?? {});
  const { coordinationPlans, rejectedCoordinationPlans } = normalizeCoordinationPlans(value, options);
  const subgoalAssignments = normalizeSubgoalAssignments(value, options);
  const { teamMessages, rejectedTeamMessages } = normalizeTeamMessages(value, options);
  if (
    missionSpecs.length === 0 &&
    coordinationPlans.length === 0 &&
    subgoalAssignments.length === 0 &&
    teamMessages.length === 0
  ) {
    return { ok: false, reason: "missing_structured_output" };
  }
  return {
    ok: true,
    value: {
      missionSpecs,
      coordinationPlans,
      subgoalAssignments,
      teamMessages,
      rejectedMissionSpecs,
      rejectedCoordinationPlans,
      rejectedTeamMessages,
      warnings: [
        ...rejectedMissionSpecs.map((entry) => ({ kind: "mission_spec", reason: entry.reason })),
        ...rejectedCoordinationPlans.map((entry) => ({ kind: "coordination_plan", reason: entry.reason })),
        ...rejectedTeamMessages.map((entry) => ({ kind: "team_message", reason: entry.reason }))
      ]
    }
  };
}

export function parseSimpleMissionText(text, meta = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/\b(?:go|goto|move)\s*(?:to)?\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?/i);
  if (!match) return null;
  return createMissionSpec({
    type: "GOTO_TILE",
    sourceChatId: meta.sourceChatId,
    sourceAgentId: meta.sourceAgentId,
    sourceMessageId: meta.sourceMessageId,
    createdBy: meta.createdBy,
    createdAtTick: meta.createdAtTick,
    objective: {
      target: { x: Number(match[1]), y: Number(match[2]) }
    },
    reason: "simple_text_mission"
  });
}
