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
    createdAtTick: candidate.createdAtTick ?? meta.createdAtTick
  });
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
    createdAtTick: meta.createdAtTick,
    objective: {
      target: { x: Number(match[1]), y: Number(match[2]) }
    },
    reason: "simple_text_mission"
  });
}
