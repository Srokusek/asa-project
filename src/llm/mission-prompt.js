import { TEAM_MESSAGE_TYPES } from "../communication/team-protocol.js";
import { MISSION_TYPES } from "../missions/mission-spec.js";

const SUPPORTED_COORDINATION_TYPES = [
  MISSION_TYPES.RENDEZVOUS,
  MISSION_TYPES.BOTH_NEAR_POSITION,
  MISSION_TYPES.COORDINATED_WAIT,
  MISSION_TYPES.RED_LIGHT_GREEN_LIGHT,
  MISSION_TYPES.HANDOFF
];

function compactPosition(position) {
  if (!position) return null;
  const x = Math.round(Number(position.x));
  const y = Math.round(Number(position.y));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function compactTeammates(team = {}) {
  return (team.teammates ?? []).slice(0, 2).map((teammate) => ({
    agentId: teammate.agentId ?? null,
    agentName: teammate.agentName ?? null,
    role: teammate.role ?? null,
    position: compactPosition(teammate.position),
    carriedCount: Number(teammate.carriedCount ?? 0),
    ready: Boolean(teammate.ready),
    stale: Boolean(teammate.stale)
  }));
}

export function compactLlmContext(context = {}) {
  const team = context.team ?? {};
  const teammates = compactTeammates(team);
  return {
    own: {
      agentId: context.own?.agentId ?? context.agentId ?? null,
      agentName: context.own?.agentName ?? context.agentName ?? context.agentId ?? null,
      role: context.own?.role ?? context.role ?? null,
      position: compactPosition(context.own?.position ?? context.position),
      carriedCount: Number(context.own?.carriedCount ?? context.carriedCount ?? 0),
      aliases: Array.isArray(context.own?.aliases) ? context.own.aliases.slice(0, 8) : []
    },
    teammate: teammates[0] ?? null,
    team: {
      teammates,
      freshCount: Number(team.freshCount ?? teammates.filter((entry) => !entry.stale).length),
      staleCount: Number(team.staleCount ?? teammates.filter((entry) => entry.stale).length)
    },
    activeMissions: Array.isArray(context.activeMissions) ? context.activeMissions.slice(0, 8) : [],
    mapSummary: context.mapSummary ?? { reds: { count: 0, sample: [] }, greens: { count: 0, sample: [] } },
    activeConstraints: context.activeConstraints ?? {},
    supportedMissionTypes: context.supportedMissionTypes ?? Object.values(MISSION_TYPES),
    supportedCoordinationTypes: context.supportedCoordinationTypes ?? SUPPORTED_COORDINATION_TYPES,
    supportedTeamMessageTypes: context.supportedTeamMessageTypes ?? Object.values(TEAM_MESSAGE_TYPES)
  };
}

export function buildMissionPrompt(message, context = {}) {
  const compactContext = compactLlmContext(context);
  return [
    {
      role: "system",
      content: [
        "You are the asynchronous coordination sidecar for a Deliveroo.js BDI agent.",
        "Return one JSON object only. Do not include Markdown, prose, comments, or trailing text.",
        "Never output low-level moves such as left/right/up/down/move sequences. BDI/pathfinding executes movement.",
        "Allowed outputs:",
        "{ \"missionSpecs\": [MissionSpec...] }",
        "{ \"coordinationPlans\": [CoordinationPlan...] }",
        "{ \"subgoalAssignments\": [{ \"to\": \"agent-id-or-name\", \"subgoal\": Subgoal... }] }",
        "{ \"teamMessages\": [{ \"type\": \"TEAM_MESSAGE_TYPE\", \"to\": \"agent-id-or-name\", \"payload\": {...} }] }",
        "{ \"clarification\": \"...\" }",
        "{ \"unsupported\": true, \"reason\": \"...\" }",
        "MissionSpec must include type, level, objective, constraints, rewardModifiers when relevant.",
        "Use assignedTo when one agent should execute a mission; otherwise leave it null only for team-wide missions.",
        "CoordinationPlan level 3 must include id, missionId, type, roles, phases, messagesToSend, fallbackPolicy, successConditions, failureConditions, and ttl.",
        "CoordinationPlan roles must use known aliases from context. Each local role should describe a target, wait, or constraint, not low-level moves.",
        "Supported Level 3 types are RENDEZVOUS, BOTH_NEAR_POSITION, COORDINATED_WAIT, RED_LIGHT_GREEN_LIGHT, and HANDOFF.",
        "Use HANDOFF only when requested; it is currently an explicit unsupported/fallback path.",
        "If the request cannot be represented by the supported schema, return unsupported with a concise reason."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        incomingMessage: message,
        context: compactContext
      })
    }
  ];
}
