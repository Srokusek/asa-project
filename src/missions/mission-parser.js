import { createMissionSpec } from "./mission-spec.js";

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

function normalizeMissionSpecs(value) {
  const rawSpecs = Array.isArray(value?.missionSpecs)
    ? value.missionSpecs
    : value?.missionSpec
      ? [value.missionSpec]
      : value?.type
        ? [value]
        : [];
  return rawSpecs.map((spec) => parseMissionSpecPayload(spec)).filter(Boolean);
}

function normalizeCoordinationPlans(value) {
  const plans = Array.isArray(value?.coordinationPlans)
    ? value.coordinationPlans
    : value?.coordinationPlan
      ? [value.coordinationPlan]
      : value?.roles && value?.phases
        ? [value]
        : [];
  return plans.filter((plan) => plan && typeof plan === "object" && plan.id && plan.roles && Array.isArray(plan.phases));
}

function normalizeSubgoalAssignments(value) {
  const assignments = Array.isArray(value?.subgoalAssignments)
    ? value.subgoalAssignments
    : value?.subgoalAssignment
      ? [value.subgoalAssignment]
      : [];
  return assignments
    .filter((assignment) => assignment && typeof assignment === "object")
    .map((assignment) => ({
      to: assignment.to ?? assignment.assignedTo ?? null,
      subgoal: assignment.subgoal ?? assignment.goal ?? assignment
    }))
    .filter((assignment) => assignment.subgoal && typeof assignment.subgoal === "object");
}

function normalizeTeamMessages(value) {
  const messages = Array.isArray(value?.teamMessages)
    ? value.teamMessages
    : value?.teamMessage
      ? [value.teamMessage]
      : [];
  return messages.filter((message) => message && typeof message === "object" && message.type);
}

export function parseLlmMissionOutput(payload) {
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

  const missionSpecs = normalizeMissionSpecs(value);
  const coordinationPlans = normalizeCoordinationPlans(value);
  const subgoalAssignments = normalizeSubgoalAssignments(value);
  const teamMessages = normalizeTeamMessages(value);
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
      teamMessages
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
