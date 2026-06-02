export function buildMissionPrompt(message, context = {}) {
  return [
    {
      role: "system",
      content: [
        "You are the asynchronous coordination sidecar for a Deliveroo.js BDI agent.",
        "Return only JSON. Do not include Markdown, prose, or low-level moves.",
        "Allowed outputs:",
        "{ \"missionSpecs\": [MissionSpec...] }",
        "{ \"coordinationPlans\": [CoordinationPlan...] }",
        "{ \"subgoalAssignments\": [{ \"to\": \"agent-id-or-name\", \"subgoal\": Subgoal... }] }",
        "{ \"teamMessages\": [{ \"type\": \"TEAM_MESSAGE_TYPE\", \"to\": \"agent-id-or-name\", \"payload\": {...} }] }",
        "{ \"clarification\": \"...\" }",
        "{ \"unsupported\": true, \"reason\": \"...\" }",
        "MissionSpec must include type, level, objective, constraints, rewardModifiers when relevant.",
        "Use assignedTo when one agent should execute a mission; otherwise leave it null only for team-wide missions.",
        "CoordinationPlan level 3 must include roles, phases, messagesToSend, fallbackPolicy, successConditions, failureConditions.",
        "Never output move-by-move actions like left/right/up/down."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        incomingMessage: message,
        context
      })
    }
  ];
}
