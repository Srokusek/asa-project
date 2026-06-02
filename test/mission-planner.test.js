import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildRoleConfig, CONFIG } from "../src/config.js";
import { AgentLoop, normalizeActionDelayMs } from "../src/control/agent-loop.js";
import { COORDINATION_STATES, CoordinationController } from "../src/coordination/coordination-controller.js";
import { createPositionHeartbeatMessage } from "../src/communication/team-heartbeat.js";
import { createAgentForRole, normalizeAgentRole } from "../src/index.js";
import { createMessageRouter } from "../src/communication/message-router.js";
import { createTeamMessage, stringifyTeamMessage, parseTeamMessage, TEAM_MESSAGE_TYPES } from "../src/communication/team-protocol.js";
import { evaluateDelivery } from "../src/missions/reward-model.js";
import { MissionRegistry } from "../src/missions/mission-registry.js";
import { parseLlmMissionOutput } from "../src/missions/mission-parser.js";
import { MISSION_TYPES } from "../src/missions/mission-spec.js";
import { buildShortHarvestPlan } from "../src/planner/search/short-harvest-rollout.js";
import { extendToRed, initialPlan } from "../src/planner/search/plan-search.js";
import { buildDistanceOracle } from "../src/planner/path/distance-oracle.js";
import { parseMap, replan, shortestGridPath, isMoveAllowed } from "../src/planner/route-planner.js";
import { shouldDeliverNow } from "../src/strategy/delivery-policy.js";
import { buildImmediatePickupPlan, tryImmediateAction } from "../src/strategy/reactive-layer.js";
import { ZoneMemory } from "../src/strategy/zone-memory.js";
import { BeliefState } from "../src/state/belief-state.js";
import { registerSdkListeners } from "../src/state/sdk-adapter.js";
import { buildPlannerState } from "../src/state/planner-state.js";
import { positionKey } from "../src/utils/geometry.js";

process.env.CHAT_DIAGNOSTICS_ENABLED = "0";
process.env.BDI_TOKEN ??= "test-bdi-token";
process.env.LLM_TOKEN ??= "test-llm-token";

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

function fakeSocket() {
  const handlers = new Map();
  const socket = {
    connected: false,
    shouts: [],
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return socket;
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    async emitShout(text) {
      socket.shouts.push(text);
      return true;
    },
    disconnect() {
      socket.connected = false;
      socket.emit("disconnect", "test_disconnect");
    }
  };
  return socket;
}

function sampleMissionSpec(overrides = {}) {
  return {
    type: MISSION_TYPES.GOTO_TILE,
    assignedTo: "standard-bdi-agent",
    objective: { target: { x: 2, y: 3 } },
    reason: "test_mission_spec",
    ...overrides
  };
}

function sampleCoordinationPlan(overrides = {}) {
  return {
    id: "coord-plan-1",
    missionId: "mission-1",
    type: MISSION_TYPES.BOTH_NEAR_POSITION,
    roles: {
      "standard-bdi-agent": {
        target: { x: 2, y: 3 },
        maxDistance: 0
      },
      "coordination-agent": {
        target: { x: 2, y: 3 },
        maxDistance: 0
      }
    },
    phases: [
      { id: "rendezvous", type: MISSION_TYPES.BOTH_NEAR_POSITION }
    ],
    messagesToSend: [],
    fallbackPolicy: "continue_bdi",
    successConditions: ["both_ready"],
    failureConditions: ["timeout"],
    ...overrides
  };
}

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function waitFor(predicate, timeoutMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not met before timeout");
}

test("parseMap uses input.params", () => {
  const state = parseMap({
    width: 1,
    height: 1,
    grid: [["3"]],
    params: { meanPackageValue: 42, immediatePickupMaxDistance: 2 }
  });
  assert.equal(state.params.meanPackageValue, 42);
  assert.equal(state.params.immediatePickupMaxDistance, 2);
});

test("route planner passes planningState.params to choosePlannerConfig", () => {
  const plan = replan({
    width: 3,
    height: 1,
    grid: [["3", "1", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    parcels: [{ id: "p1", x: 1, y: 0, reward: 10, confidence: 1 }],
    params: { ...CONFIG.planner, beamWidth: 7, topK: 1, decayRate: 0 }
  });
  assert.equal(plan.config.beamWidth, 7);
  assert.equal(plan.config.topK, 1);
});

test("ACTION_DELAY_MS=0 is not forced to 20", () => {
  assert.equal(normalizeActionDelayMs({ actionDelayMs: 0 }), 0);
});

test("competitive defaults are enabled but still overrideable", () => {
  assert.equal(CONFIG.actionDelayMs, 0);
  assert.ok(CONFIG.planner.planningBudgetMs <= 50);
  assert.ok(CONFIG.planner.shortHarvestBudgetMs <= 20);
  assert.equal(normalizeActionDelayMs({ actionDelayMs: 17 }), 17);
});

test("AGENT_ROLE=bdi uses BDI_TOKEN and BDI_AGENT_NAME", () => withEnv({
  AGENT_ROLE: "bdi",
  BDI_TOKEN: "bdi-token",
  BDI_AGENT_NAME: "bdi-name",
  LLM_TOKEN: "llm-token",
  LLM_AGENT_NAME: "llm-name",
  TOKEN: "fallback-token"
}, () => {
  const config = buildRoleConfig({ ...CONFIG, token: "base-token", agentName: "base-name" });

  assert.equal(config.agentRole, "bdi");
  assert.equal(config.token, "bdi-token");
  assert.equal(config.agentName, "bdi-name");
  assert.equal(config.team.selfName, "bdi-name");
  assert.equal(config.team.peerName, "llm-name");
  assert.ok(config.missions.enabled);
  assert.equal(config.llm, undefined);
}));

test("AGENT_ROLE=llm uses LLM_TOKEN and LLM_AGENT_NAME", () => withEnv({
  AGENT_ROLE: "llm",
  BDI_TOKEN: "bdi-token",
  BDI_AGENT_NAME: "bdi-name",
  LLM_TOKEN: "llm-token",
  LLM_AGENT_NAME: "llm-name",
  LITELLM_API_KEY: "llm-api-key",
  LOCAL_MODEL: "test-model",
  TOKEN: "fallback-token"
}, () => {
  const config = buildRoleConfig({ ...CONFIG, token: "base-token", agentName: "base-name" });

  assert.equal(config.agentRole, "llm");
  assert.equal(config.token, "llm-token");
  assert.equal(config.agentName, "llm-name");
  assert.equal(config.team.selfName, "llm-name");
  assert.equal(config.team.peerName, "bdi-name");
  assert.ok(config.missions.enabled);
  assert.equal(config.llm.apiKey, "llm-api-key");
  assert.equal(config.llm.model, "test-model");
}));

test("buildRoleConfig warns when both agent roles resolve to the same token", () => withEnv({
  AGENT_ROLE: "bdi",
  BDI_TOKEN: undefined,
  LLM_TOKEN: undefined,
  TOKEN: "shared-token"
}, () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    buildRoleConfig({ ...CONFIG, token: "base-token" }, "bdi");
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.some((message) => message.includes("same Deliveroo token")));
}));

test("role selection creates operational BDI loops without default chat LLM", () => {
  assert.equal(normalizeAgentRole("coordination"), "llm");
  assert.equal(normalizeAgentRole("bdi"), "bdi");

  const baseConfig = { ...CONFIG, agentName: "TestAgent", actionDelayMs: 1000 };
  const bdi = createAgentForRole("bdi", baseConfig, { socket: fakeSocket(), logger: logger() });
  const llm = createAgentForRole("llm", baseConfig, {
    socket: fakeSocket(),
    logger: logger(),
    llmClient: { isMock: true, call: async () => ({ message: { content: "{\"unsupported\":true}" } }) }
  });

  assert.equal(bdi.config.agentRole, "bdi");
  assert.equal(llm.config.agentRole, "llm");
  assert.equal(bdi.loop.chatProcessor, null);
  assert.equal(llm.loop.chatProcessor, null);
  assert.ok(bdi.loop.coordinationController);
  assert.ok(llm.loop.coordinationController);
});

test("StandardBDIAgent does not receive active LLM config or client", () => withEnv({
  BDI_TOKEN: "bdi-token",
  BDI_AGENT_NAME: "StandardRuntime",
  LLM_TOKEN: "llm-token",
  LLM_AGENT_NAME: "CoordinationRuntime",
  LITELLM_API_KEY: "llm-api-key"
}, () => {
  const agent = createAgentForRole("bdi", CONFIG, { socket: fakeSocket(), logger: logger() });

  assert.equal(agent.config.agentRole, "bdi");
  assert.equal(agent.config.token, "bdi-token");
  assert.equal(agent.config.agentName, "StandardRuntime");
  assert.equal(agent.config.llm, undefined);
  assert.equal(agent.llmClient, undefined);
}));

test("CoordinationBDIAgent receives LLM config and instantiates sidecar client", () => withEnv({
  BDI_TOKEN: "bdi-token",
  BDI_AGENT_NAME: "StandardRuntime",
  LLM_TOKEN: "llm-token",
  LLM_AGENT_NAME: "CoordinationRuntime",
  LITELLM_API_KEY: "llm-api-key",
  LOCAL_MODEL: "coordination-model"
}, () => {
  const agent = createAgentForRole("llm", CONFIG, { socket: fakeSocket(), logger: logger() });

  assert.equal(agent.config.agentRole, "llm");
  assert.equal(agent.config.token, "llm-token");
  assert.equal(agent.config.agentName, "CoordinationRuntime");
  assert.equal(agent.config.llm.apiKey, "llm-api-key");
  assert.equal(agent.config.llm.model, "coordination-model");
  assert.equal(typeof agent.llmClient.call, "function");
  assert.ok(agent.loop.coordinationController);
}));

test("TeamProtocol serialize/parse roundtrip works for MissionSpec", () => {
  const raw = stringifyTeamMessage({
    type: TEAM_MESSAGE_TYPES.MISSION_SPEC,
    from: "coordination-agent",
    to: "standard-bdi-agent",
    tick: 4,
    ttl: 9,
    payload: { missionSpec: sampleMissionSpec() }
  });
  const parsed = parseTeamMessage(raw);

  assert.equal(parsed.protocol, "ASA_TEAM_V1");
  assert.equal(parsed.type, TEAM_MESSAGE_TYPES.MISSION_SPEC);
  assert.equal(parsed.payload.missionSpec.type, MISSION_TYPES.GOTO_TILE);
});

test("TeamProtocol accepts valid CoordinationPlan payload", () => {
  const message = createTeamMessage(
    TEAM_MESSAGE_TYPES.COORDINATION_PLAN,
    "coordination-agent",
    "standard-bdi-agent",
    { coordinationPlan: sampleCoordinationPlan() },
    { tick: 0, ttl: 10 }
  );
  const parsed = parseTeamMessage(stringifyTeamMessage(message));

  assert.equal(parsed.type, TEAM_MESSAGE_TYPES.COORDINATION_PLAN);
  assert.equal(parsed.payload.coordinationPlan.id, "coord-plan-1");
});

test("TeamProtocol rejects invalid CoordinationPlan payload", () => {
  assert.throws(
    () => createTeamMessage(
      TEAM_MESSAGE_TYPES.COORDINATION_PLAN,
      "coordination-agent",
      "standard-bdi-agent",
      { coordinationPlan: { id: "missing-required-shape" } },
      { tick: 0, ttl: 10 }
    ),
    /missing_coordination_plan_roles/
  );
});

test("MessageRouter keeps TeamProtocol separate from natural mission chat and deduplicates", () => {
  const router = createMessageRouter({ selfId: "bdi-1" });
  const teamMessage = createTeamMessage(
    TEAM_MESSAGE_TYPES.MISSION_SPEC,
    "coord",
    "bdi-1",
    { missionSpec: sampleMissionSpec({ objective: { target: { x: 1, y: 2 } } }) },
    { id: "msg-1", tick: 0, ttl: 10 }
  );

  assert.equal(router.routeIncomingChat({ fromId: "admin", text: "go to 1,2" }, 0).kind, "mission_text");
  assert.equal(router.routeIncomingChat({ fromId: "coord", text: JSON.stringify(teamMessage) }, 0).kind, "team");
  assert.equal(router.routeTeamMessage(teamMessage, 0).reason, "duplicate_team_message");
  assert.equal(router.consumeMissionMessages().length, 1);
  assert.equal(router.consumeTeamMessagesFor("bdi-1", 0).length, 1);
});

test("TeamProtocol messages are not routed to natural LLM chat", () => {
  const socket = fakeSocket();
  const beliefs = new BeliefState(CONFIG);
  const router = createMessageRouter({ role: "llm", aliases: ["coordination-agent"] });
  const message = createTeamMessage(
    TEAM_MESSAGE_TYPES.MISSION_SPEC,
    "standard-bdi-agent",
    "coordination-agent",
    { missionSpec: sampleMissionSpec({ assignedTo: "coordination-agent" }) },
    { id: "sdk-team-message", tick: 0, ttl: 10 }
  );

  registerSdkListeners(socket, beliefs, null, { messageRouter: router });
  socket.emit("msg", { fromId: "standard-bdi-agent", text: stringifyTeamMessage(message) });
  socket.emit("msg", { fromId: "standard-bdi-agent", text: stringifyTeamMessage(message) });

  assert.equal(router.consumeMissionMessages().length, 0);
  assert.equal(beliefs.chatInbox.length, 0);
  assert.equal(beliefs.teamMessages.length, 1);
  assert.equal(router.consumeTeamMessagesForAliases(["coordination-agent", "llm-agent"], 0).length, 1);
});

test("sdk-adapter routeNaturalChat=false drops natural chat but keeps TeamProtocol", () => {
  const socket = fakeSocket();
  const beliefs = new BeliefState(CONFIG);
  const router = createMessageRouter({ role: "bdi", aliases: ["standard-bdi-agent"] });
  const message = createTeamMessage(
    TEAM_MESSAGE_TYPES.STATUS_UPDATE,
    "coordination-agent",
    "standard-bdi-agent",
    { status: "READY" },
    { id: "route-false-team", tick: 0, ttl: 10 }
  );

  registerSdkListeners(socket, beliefs, null, {
    messageRouter: router,
    routeNaturalChat: false,
    config: { ...CONFIG, adminId: "admin" }
  });
  socket.emit("msg", { fromId: "admin", text: "natural instruction" });
  socket.emit("msg", { fromId: "coordination-agent", text: stringifyTeamMessage(message) });

  assert.equal(beliefs.chatInbox.length, 0);
  assert.equal(router.consumeMissionMessages().length, 0);
  assert.equal(beliefs.teamMessages.length, 1);
  assert.equal(router.consumeTeamMessagesForAliases(["standard-bdi-agent"], 0).length, 1);
});

test("sdk-adapter routeNaturalChat=true routes natural chat without CONFIG global", () => {
  const socket = fakeSocket();
  const beliefs = new BeliefState({ ...CONFIG, adminId: null });
  const router = createMessageRouter({ role: "llm", aliases: ["coordination-agent"] });

  registerSdkListeners(socket, beliefs, null, {
    messageRouter: router,
    routeNaturalChat: true,
    config: { ...CONFIG, adminId: null }
  });
  socket.emit("msg", { fromId: "admin", text: "coordinate rendezvous" });

  assert.equal(beliefs.chatInbox.length, 1);
  assert.equal(router.consumeMissionMessages().length, 1);
  const source = readFileSync(new URL("../src/state/sdk-adapter.js", import.meta.url), "utf8");
  assert.equal(source.includes("CONFIG"), false);
});

test("MessageRouter consumeTeamMessagesForAliases receives any matching alias", () => {
  const router = createMessageRouter({ role: "bdi", aliases: ["runtime-bdi", "standard-bdi-agent"] });
  for (const [id, to] of [
    ["alias-msg-1", "runtime-bdi"],
    ["alias-msg-2", "standard-bdi-agent"],
    ["alias-msg-3", "bdi-agent"]
  ]) {
    router.routeTeamMessage(createTeamMessage(
      TEAM_MESSAGE_TYPES.STATUS_UPDATE,
      "coordination-agent",
      to,
      { status: "READY" },
      { id, tick: 0, ttl: 10 }
    ), 0);
  }

  const messages = router.consumeTeamMessagesForAliases(["runtime-bdi", "standard-bdi-agent", "bdi-agent"], 0);
  assert.deepEqual(messages.map((message) => message.id), ["alias-msg-1", "alias-msg-2", "alias-msg-3"]);
});

test("MessageRouter ignores expired TeamProtocol messages", () => {
  const router = createMessageRouter({ role: "bdi", aliases: ["standard-bdi-agent"] });
  const expired = createTeamMessage(
    TEAM_MESSAGE_TYPES.STATUS_UPDATE,
    "coordination-agent",
    "standard-bdi-agent",
    { status: "STALE" },
    { id: "expired-msg", tick: 1, ttl: 1 }
  );

  assert.equal(router.routeTeamMessage(expired, 3).reason, "invalid_or_expired");
  router.routeTeamMessage({ ...expired, id: "fresh-then-expired", tick: 0, ttl: 1 }, 0);
  assert.equal(router.consumeTeamMessagesForAliases(["standard-bdi-agent"], 2).length, 0);
});

test("Position heartbeat message is created correctly", () => {
  const config = {
    ...CONFIG,
    agentName: "StandardBDIAgent",
    agentRole: "bdi",
    team: { ...CONFIG.team, heartbeatTicks: 5, heartbeatTtlTicks: 15 }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(1, 1, [{ x: 0, y: 0, type: "3" }]);
  beliefs.updateSelf({ id: "bdi-runtime", name: "StandardBDIAgent", x: 0, y: 0, score: 7 });
  beliefs.carriedParcels.set("p1", { id: "p1" });
  beliefs.pushManualTask({
    type: "goto_tile",
    payload: { missionId: "m-heartbeat", target: { x: 1, y: 1 }, reason: "test_task" }
  });

  const message = createPositionHeartbeatMessage({ beliefs, config });
  assert.equal(message.type, TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT);
  assert.equal(message.from, "StandardBDIAgent");
  assert.equal(message.ttl, 15);
  assert.equal(message.payload.agentId, "bdi-runtime");
  assert.equal(message.payload.agentName, "StandardBDIAgent");
  assert.equal(message.payload.role, "bdi");
  assert.deepEqual(message.payload.position, { x: 0, y: 0 });
  assert.equal(message.payload.carriedCount, 1);
  assert.equal(message.payload.currentTask.missionId, "m-heartbeat");
  assert.equal(message.payload.ready, true);
});

test("agents send heartbeat according to configured interval", () => {
  const baseConfig = {
    ...CONFIG,
    actionDelayMs: 1000,
    team: { ...CONFIG.team, heartbeatTicks: 5, heartbeatTtlTicks: 15 }
  };
  const bdiSocket = fakeSocket();
  const llmSocket = fakeSocket();
  const bdi = createAgentForRole("bdi", { ...baseConfig, agentName: "StandardBDIAgent" }, {
    socket: bdiSocket,
    logger: logger()
  });
  const llm = createAgentForRole("llm", { ...baseConfig, agentName: "CoordinationBDIAgent" }, {
    socket: llmSocket,
    logger: logger(),
    llmClient: { isMock: true, call: async () => ({ message: { content: "{\"unsupported\":true}" } }) }
  });

  for (const agent of [bdi, llm]) {
    agent.beliefs.updateMap(1, 1, [{ x: 0, y: 0, type: "3" }]);
    agent.beliefs.updateSelf({ id: `${agent.config.agentRole}-runtime`, name: agent.config.agentName, x: 0, y: 0 });
    agent.beliefs.time = 5;
    agent.processTeamInbox();
    agent.processTeamInbox();
    agent.beliefs.time = 9;
    agent.processTeamInbox();
    agent.beliefs.time = 10;
    agent.processTeamInbox();
  }

  assert.deepEqual(bdiSocket.shouts.map((raw) => parseTeamMessage(raw).type), [
    TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT,
    TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT
  ]);
  assert.deepEqual(llmSocket.shouts.map((raw) => parseTeamMessage(raw).type), [
    TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT,
    TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT
  ]);
});

test("TeamState updates when receiving heartbeat", () => {
  const beliefs = new BeliefState(CONFIG);
  const teammate = beliefs.updateTeamHeartbeat({
    agentId: "bdi-runtime",
    agentName: "StandardBDIAgent",
    role: "bdi",
    position: { x: 3, y: 4 },
    score: 11,
    carriedCount: 2,
    currentTask: { type: "goto_tile", target: { x: 5, y: 5 } },
    ready: true,
    tick: 12
  }, { receivedAtTick: 12, ttl: 10 });

  assert.equal(teammate.agentName, "StandardBDIAgent");
  assert.deepEqual(beliefs.getTeammate("bdi-runtime").position, { x: 3, y: 4 });
  assert.equal(beliefs.getTeammate("StandardBDIAgent").carriedCount, 2);
  assert.equal(beliefs.teammateSummary(12).freshCount, 1);
});

test("TeamState marks heartbeat stale after ttl", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateTeamHeartbeat({
    agentId: "bdi-runtime",
    agentName: "StandardBDIAgent",
    role: "bdi",
    position: { x: 3, y: 4 },
    score: 0,
    carriedCount: 0,
    currentTask: null,
    ready: true,
    tick: 1
  }, { receivedAtTick: 1, ttl: 5 });

  assert.equal(beliefs.isTeammateStale("bdi-runtime", 6), false);
  assert.equal(beliefs.isTeammateStale("bdi-runtime", 7), true);
  assert.equal(beliefs.teammatePosition("bdi-runtime", 7), null);
});

test("CoordinationController can read teammate position", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateTeamHeartbeat({
    agentId: "bdi-runtime",
    agentName: "StandardBDIAgent",
    role: "bdi",
    position: { x: 8, y: 9 },
    score: 0,
    carriedCount: 0,
    currentTask: null,
    ready: true,
    tick: 3
  }, { receivedAtTick: 3, ttl: 20 });
  const controller = new CoordinationController({ agentId: "CoordinationBDIAgent", beliefs });

  assert.deepEqual(controller.teammatePosition("StandardBDIAgent", 4), { x: 8, y: 9 });
  assert.equal(controller.teamSummary(4).freshCount, 1);
});

test("LLM context includes teammate summary", async () => {
  let capturedPrompt = null;
  const llmClient = {
    isMock: true,
    call: async (messages) => {
      capturedPrompt = messages;
      return {
        message: {
          content: JSON.stringify({
            teamMessages: [
              { type: TEAM_MESSAGE_TYPES.STATUS_UPDATE, to: "standard-bdi-agent", payload: { status: "READY" } }
            ]
          })
        }
      };
    }
  };
  const agent = createAgentForRole("llm", {
    ...CONFIG,
    agentName: "CoordinationBDIAgent",
    agentRole: "llm",
    llm: { apiKey: "test-key", model: "test-model" }
  }, { socket: fakeSocket(), logger: logger(), llmClient });
  agent.beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  agent.beliefs.updateSelf({ id: "runtime-llm", name: "coordination", x: 0, y: 0 });
  agent.beliefs.updateParcelsSensing([{ id: "p1", x: 1, y: 0, reward: 10 }], [{ x: 1, y: 0 }]);
  agent.beliefs.updateTeamHeartbeat({
    agentId: "bdi-runtime",
    agentName: "StandardBDIAgent",
    role: "bdi",
    position: { x: 4, y: 6 },
    score: 10,
    carriedCount: 1,
    currentTask: { type: "goto_tile", target: { x: 4, y: 6 } },
    ready: true,
    tick: 2
  }, { receivedAtTick: 2, ttl: 20 });
  agent.beliefs.time = 3;

  await agent.translateChat({ fromId: "admin", text: "coordinate rendezvous" });
  const body = JSON.parse(capturedPrompt[1].content);
  const [teammate] = body.context.team.teammates;

  assert.equal(body.context.own.agentId, "runtime-llm");
  assert.equal(body.context.own.role, "llm");
  assert.deepEqual(body.context.own.position, { x: 0, y: 0 });
  assert.equal(teammate.agentId, "bdi-runtime");
  assert.deepEqual(teammate.position, { x: 4, y: 6 });
  assert.equal(teammate.stale, false);
  assert.equal(body.context.mapSummary.reds.count, 1);
  assert.equal(body.context.mapSummary.greens.withParcelCount, 1);
  assert.ok(body.context.supportedMissionTypes.includes(MISSION_TYPES.GOTO_TILE));
  assert.ok(body.context.supportedCoordinationTypes.includes(MISSION_TYPES.BOTH_NEAR_POSITION));
});

test("StandardBDIAgent receives MissionSpec and queues executable subgoal", async () => {
  const socket = fakeSocket();
  const agent = createAgentForRole("bdi", { ...CONFIG, agentName: "StandardBDIAgent" }, { socket, logger: logger() });
  agent.beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });

  const message = createTeamMessage(
    TEAM_MESSAGE_TYPES.MISSION_SPEC,
    "CoordinationBDIAgent",
    "runtime-bdi",
    {
      missionSpec: {
        type: MISSION_TYPES.GOTO_TILE,
        assignedTo: "runtime-bdi",
        objective: { target: { x: 2, y: 3 } },
        reason: "test_goto"
      }
    },
    { tick: agent.beliefs.time, ttl: 30 }
  );

  const result = agent.handleTeamMessage(message);
  await Promise.resolve();

  assert.equal(result.accepted, true);
  assert.equal(agent.loop.chatProcessor, null);
  assert.equal(agent.beliefs.manualTasks.length, 1);
  assert.deepEqual(agent.beliefs.manualTasks[0].payload.target, { x: 2, y: 3 });
  assert.equal(agent.beliefs.missionRegistry.activeLevel1(agent.beliefs.time).length, 1);
  assert.equal(parseTeamMessage(socket.shouts.at(-1)).type, TEAM_MESSAGE_TYPES.MISSION_ACCEPTED);
});

test("CoordinationBDIAgent receives MissionSpec while preserving BDI gameplay loop", async () => {
  const socket = fakeSocket();
  const agent = createAgentForRole("llm", { ...CONFIG, agentName: "CoordinationBDIAgent" }, {
    socket,
    logger: logger(),
    llmClient: { isMock: true, call: async () => ({ message: { content: "{\"unsupported\":true}" } }) }
  });
  agent.beliefs.updateSelf({ id: "runtime-llm", name: "llm", x: 0, y: 0 });

  const message = createTeamMessage(
    TEAM_MESSAGE_TYPES.MISSION_SPEC,
    "StandardBDIAgent",
    "runtime-llm",
    {
      missionSpec: {
        type: MISSION_TYPES.GOTO_TILE,
        assignedTo: "runtime-llm",
        objective: { target: { x: 4, y: 5 } },
        reason: "test_llm_goto"
      }
    },
    { tick: agent.beliefs.time, ttl: 30 }
  );

  const result = agent.handleTeamMessage(message);
  await Promise.resolve();

  assert.equal(result.accepted, true);
  assert.equal(agent.loop.chatProcessor, null);
  assert.equal(agent.beliefs.manualTasks.length, 1);
  assert.deepEqual(agent.beliefs.manualTasks[0].payload.target, { x: 4, y: 5 });
  assert.equal(parseTeamMessage(socket.shouts.at(-1)).type, TEAM_MESSAGE_TYPES.MISSION_ACCEPTED);
});

test("LLM sidecar is asynchronous and emits only structured team outputs", async () => {
  let release;
  const socket = fakeSocket();
  const llmClient = {
    isMock: true,
    call: async () => new Promise((resolve) => {
      release = () => resolve({
        message: {
          content: JSON.stringify({
            missionSpecs: [
              {
                type: MISSION_TYPES.GOTO_TILE,
                assignedTo: "runtime-llm",
                objective: { target: { x: 1, y: 2 } },
                reason: "sidecar_test"
              }
            ],
            subgoalAssignments: [
              {
                to: "runtime-bdi",
                subgoal: {
                  type: MISSION_TYPES.BOTH_NEAR_POSITION,
                  target: { x: 1, y: 2 },
                  missionId: "m-sidecar"
                }
              }
            ],
            teamMessages: [
              {
                type: TEAM_MESSAGE_TYPES.STATUS_UPDATE,
                to: "runtime-bdi",
                payload: { status: "PLANNED" }
              }
            ]
          })
        }
      });
    })
  };
  const agent = createAgentForRole("llm", { ...CONFIG, agentName: "CoordinationBDIAgent" }, {
    socket,
    logger: logger(),
    llmClient
  });
  agent.beliefs.updateSelf({ id: "runtime-llm", name: "llm", x: 0, y: 0 });
  agent.messageRouter.routeIncomingChat({ fromId: "admin", text: "coordinate goto" }, agent.beliefs.time);

  const startedAt = Date.now();
  assert.equal(agent.kickSidecar(), true);
  assert.ok(Date.now() - startedAt < 20);
  assert.equal(agent.inFlight, true);
  assert.equal(agent.beliefs.manualTasks.length, 0);

  release();
  await waitFor(() => agent.inFlight === false);

  const types = socket.shouts.map((raw) => parseTeamMessage(raw).type);
  assert.deepEqual(types, [
    TEAM_MESSAGE_TYPES.MISSION_ACCEPTED,
    TEAM_MESSAGE_TYPES.MISSION_SPEC,
    TEAM_MESSAGE_TYPES.SUBGOAL_ASSIGNMENT,
    TEAM_MESSAGE_TYPES.STATUS_UPDATE
  ]);
  assert.equal(agent.missionsSent.size, 1);
  assert.equal(agent.beliefs.manualTasks.length, 1);
  assert.deepEqual(agent.beliefs.manualTasks[0].payload.target, { x: 1, y: 2 });
});

test("LLM output parser accepts subgoal assignments and TeamProtocol messages", () => {
  const parsed = parseLlmMissionOutput(JSON.stringify({
    subgoalAssignments: [
      { to: "bdi", subgoal: { type: MISSION_TYPES.BOTH_NEAR_POSITION, target: { x: 1, y: 1 } } }
    ],
    teamMessages: [
      { type: TEAM_MESSAGE_TYPES.STATUS_UPDATE, to: "bdi", payload: { status: "READY" } }
    ]
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.subgoalAssignments.length, 1);
  assert.equal(parsed.value.teamMessages[0].type, TEAM_MESSAGE_TYPES.STATUS_UPDATE);
});

test("LLM output parser accepts valid MissionSpec", () => {
  const parsed = parseLlmMissionOutput(JSON.stringify({
    missionSpecs: [
      {
        type: MISSION_TYPES.GOTO_TILE,
        level: 1,
        assignedTo: "standard-bdi-agent",
        objective: { target: { x: 2, y: 3 } }
      }
    ]
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.missionSpecs.length, 1);
  assert.equal(parsed.value.missionSpecs[0].type, MISSION_TYPES.GOTO_TILE);
});

test("LLM output parser rejects invalid or free JSON", () => {
  assert.equal(parseLlmMissionOutput("not json").ok, false);
  assert.equal(parseLlmMissionOutput(JSON.stringify("free text")).ok, false);
  assert.equal(parseLlmMissionOutput(JSON.stringify({ text: "do something please" })).reason, "missing_structured_output");
});

test("LLM output parser accepts valid CoordinationPlan and normalizes role aliases", () => {
  const parsed = parseLlmMissionOutput(JSON.stringify({
    coordinationPlans: [
      sampleCoordinationPlan({
        id: "parser-plan",
        roles: {
          llm: { target: { x: 1, y: 1 }, maxDistance: 0 },
          bdi: { target: { x: 1, y: 1 }, maxDistance: 0 }
        }
      })
    ]
  }), {
    roleAliases: {
      "coordination-agent": ["llm", "coordination-agent"],
      "standard-bdi-agent": ["bdi", "standard-bdi-agent"]
    }
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed.value.coordinationPlans[0].roles).sort(), [
    "coordination-agent",
    "standard-bdi-agent"
  ]);
});

test("LLM output parser discards teamMessage with invalid type", () => {
  const parsed = parseLlmMissionOutput(JSON.stringify({
    teamMessages: [
      { type: TEAM_MESSAGE_TYPES.STATUS_UPDATE, to: "bdi", payload: { status: "READY" } },
      { type: "TOTALLY_NOT_A_TEAM_TYPE", to: "bdi", payload: { status: "NOPE" } }
    ]
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.teamMessages.length, 1);
  assert.equal(parsed.value.rejectedTeamMessages.length, 1);
  assert.equal(parsed.value.warnings[0].reason, "invalid_team_message_type");
});

test("LLM unsupported output is handled without crash", async () => {
  const socket = fakeSocket();
  const agent = createAgentForRole("llm", {
    ...CONFIG,
    agentName: "CoordinationBDIAgent",
    llm: { apiKey: "test-key", model: "test-model" }
  }, {
    socket,
    logger: logger(),
    llmClient: {
      isMock: true,
      call: async () => ({ message: { content: JSON.stringify({ unsupported: true, reason: "not_supported" }) } })
    }
  });

  const output = await agent.translateChat({ fromId: "admin", text: "do unsupported thing" });
  await agent.publishStructuredOutput(output, { fromId: "admin" });

  assert.equal(output.unsupported, true);
  assert.equal(parseTeamMessage(socket.shouts[0]).type, TEAM_MESSAGE_TYPES.MISSION_REJECTED);
  assert.equal(parseTeamMessage(socket.shouts[0]).payload.reason, "not_supported");
  assert.equal(agent.beliefs.missionRegistry.activeMissions(agent.beliefs.time).length, 0);
});

test("LLM clarification produces response without side effects", async () => {
  const socket = fakeSocket();
  const agent = createAgentForRole("llm", { ...CONFIG, agentName: "CoordinationBDIAgent" }, {
    socket,
    logger: logger(),
    llmClient: { isMock: true, call: async () => ({ message: { content: "{\"unsupported\":true}" } }) }
  });

  await agent.publishStructuredOutput({ clarification: "Which target tile?" }, { fromId: "admin", chatId: 7 });
  const message = parseTeamMessage(socket.shouts[0]);

  assert.equal(message.type, TEAM_MESSAGE_TYPES.STATUS_UPDATE);
  assert.equal(message.payload.status, "CLARIFICATION_REQUESTED");
  assert.equal(message.payload.reason, "Which target tile?");
  assert.equal(agent.beliefs.missionRegistry.activeMissions(agent.beliefs.time).length, 0);
});

test("LLM invalid JSON after retry becomes unsupported response", async () => {
  const socket = fakeSocket();
  let calls = 0;
  const agent = createAgentForRole("llm", {
    ...CONFIG,
    agentName: "CoordinationBDIAgent",
    llm: { apiKey: "test-key", model: "test-model" }
  }, {
    socket,
    logger: logger(),
    llmClient: {
      isMock: true,
      call: async () => {
        calls += 1;
        return { message: { content: "still not json" } };
      }
    }
  });

  const output = await agent.translateChat({ fromId: "admin", text: "please coordinate" });
  await agent.publishStructuredOutput(output, { fromId: "admin" });

  assert.equal(calls, 2);
  assert.equal(output.unsupported, true);
  assert.equal(output.reason, "invalid_llm_output");
  assert.equal(parseTeamMessage(socket.shouts[0]).payload.reason, "invalid_llm_output");
  assert.equal(agent.beliefs.missionRegistry.activeMissions(agent.beliefs.time).length, 0);
});

test("LLM invalid MissionSpec is rejected without registry side effects", async () => {
  const socket = fakeSocket();
  const agent = createAgentForRole("llm", { ...CONFIG, agentName: "CoordinationBDIAgent" }, {
    socket,
    logger: logger(),
    llmClient: { isMock: true, call: async () => ({ message: { content: "{\"unsupported\":true}" } }) }
  });

  await agent.publishStructuredOutput({
    missionSpecs: [{ type: "NOT_A_REAL_MISSION", objective: { target: { x: 1, y: 1 } } }]
  }, { fromId: "admin" });

  assert.equal(agent.beliefs.missionRegistry.activeMissions(agent.beliefs.time).length, 0);
  assert.equal(parseTeamMessage(socket.shouts[0]).type, TEAM_MESSAGE_TYPES.MISSION_REJECTED);
});

test("CoordinationBDIAgent applies locally generated CoordinationPlan for its own role", async () => {
  const socket = fakeSocket();
  const agent = createAgentForRole("llm", { ...CONFIG, agentName: "CoordinationBDIAgent" }, {
    socket,
    logger: logger(),
    llmClient: { isMock: true, call: async () => ({ message: { content: "{\"unsupported\":true}" } }) }
  });
  agent.beliefs.updateSelf({ id: "runtime-llm", name: "llm", x: 0, y: 0 });
  const plan = sampleCoordinationPlan({
    id: "level3-plan-local",
    missionId: "mission-level3-local",
    type: MISSION_TYPES.BOTH_NEAR_POSITION,
    roles: {
      "coordination-agent": { target: { x: 2, y: 2 }, maxDistance: 0 },
      "standard-bdi-agent": { target: { x: 2, y: 2 }, maxDistance: 0 }
    },
    ttl: 20
  });

  await agent.publishStructuredOutput({ coordinationPlans: [plan] }, { fromId: "admin" });

  const entry = agent.coordinationController.plans.get("level3-plan-local");
  assert.equal(entry.state, COORDINATION_STATES.EXECUTING);
  assert.equal(agent.beliefs.manualTasks.length, 1);
  assert.deepEqual(agent.beliefs.manualTasks[0].payload.target, { x: 2, y: 2 });
  assert.deepEqual(socket.shouts.map((raw) => parseTeamMessage(raw).type), [
    TEAM_MESSAGE_TYPES.RENDEZVOUS_ACK,
    TEAM_MESSAGE_TYPES.MISSION_ACCEPTED,
    TEAM_MESSAGE_TYPES.COORDINATION_PLAN
  ]);
});

test("StandardBDIAgent receives CoordinationPlan and creates local subgoal", () => {
  const socket = fakeSocket();
  const agent = createAgentForRole("bdi", { ...CONFIG, agentName: "StandardBDIAgent" }, { socket, logger: logger() });
  agent.beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const plan = sampleCoordinationPlan({
    id: "level3-plan-standard",
    missionId: "mission-level3-standard",
    roles: {
      "coordination-agent": { target: { x: 3, y: 1 }, maxDistance: 0 },
      "standard-bdi-agent": { target: { x: 3, y: 1 }, maxDistance: 0 }
    },
    ttl: 20
  });
  const message = createTeamMessage(
    TEAM_MESSAGE_TYPES.COORDINATION_PLAN,
    "CoordinationBDIAgent",
    null,
    { coordinationPlan: plan },
    { tick: agent.beliefs.time, ttl: 20 }
  );

  const result = agent.handleTeamMessage(message);

  assert.equal(result.accepted, true);
  assert.equal(agent.coordinationController.plans.get("level3-plan-standard").state, COORDINATION_STATES.EXECUTING);
  assert.equal(agent.beliefs.manualTasks.length, 1);
  assert.deepEqual(agent.beliefs.manualTasks[0].payload.target, { x: 3, y: 1 });
});

test("RENDEZVOUS near position creates goto subgoal and ready status", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateMap(1, 1, [{ x: 0, y: 0, type: "3" }]);
  beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent", "runtime-bdi"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });

  controller.receiveCoordinationPlan(sampleCoordinationPlan({
    id: "rendezvous-ready-plan",
    missionId: "mission-rendezvous-ready",
    type: MISSION_TYPES.RENDEZVOUS,
    roles: {
      "standard-bdi-agent": { target: { x: 0, y: 0 }, maxDistance: 0 }
    },
    ttl: 20
  }), "coordination-agent");
  controller.update();

  assert.equal(beliefs.manualTasks.length, 1);
  assert.equal(controller.plans.get("rendezvous-ready-plan").state, COORDINATION_STATES.COMPLETED);
  assert.equal(controller.outbox.some((message) => message.type === TEAM_MESSAGE_TYPES.RENDEZVOUS_READY), true);
  assert.equal(controller.outbox.some((message) => message.type === TEAM_MESSAGE_TYPES.STATUS_UPDATE), true);
  assert.equal(controller.outbox.some((message) => message.type === TEAM_MESSAGE_TYPES.MISSION_COMPLETED), true);
});

test("COORDINATED_WAIT creates wait state and ready status after wait", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });

  controller.receiveCoordinationPlan({
    id: "wait-plan",
    missionId: "mission-wait",
    type: MISSION_TYPES.COORDINATED_WAIT,
    roles: { "standard-bdi-agent": { type: MISSION_TYPES.COORDINATED_WAIT, waitTicks: 2 } },
    phases: [{ id: "wait", type: MISSION_TYPES.COORDINATED_WAIT }],
    ttl: 20
  }, "coordination-agent");

  assert.equal(controller.plans.get("wait-plan").state, COORDINATION_STATES.WAITING_TEAMMATE);
  assert.equal(beliefs.manualTasks.length, 0);
  assert.equal(controller.outbox.some((message) => message.payload?.status === "WAITING_TEAMMATE"), true);

  beliefs.time = 2;
  controller.update();
  assert.equal(controller.plans.get("wait-plan").state, COORDINATION_STATES.COMPLETED);
  assert.equal(controller.outbox.some((message) => message.payload?.reason === "coordinated_wait_complete"), true);
});

test("RED_LIGHT blocks moves but not status/chat actions, and GREEN_LIGHT resumes", () => {
  const beliefs = new BeliefState(CONFIG);
  const controller = new CoordinationController({ agentId: "StandardBDIAgent", beliefs });
  controller.receiveTeamMessage(createTeamMessage(
    TEAM_MESSAGE_TYPES.RED_LIGHT,
    "CoordinationBDIAgent",
    "StandardBDIAgent",
    { reason: "test_red_light" },
    { tick: 0, ttl: 10 }
  ));

  assert.equal(controller.movementBlocked({ type: "move" }), true);
  assert.equal(controller.movementBlocked({ type: "write_message" }), false);
  assert.equal(controller.movementBlocked({ type: "status" }), false);

  controller.receiveTeamMessage(createTeamMessage(
    TEAM_MESSAGE_TYPES.GREEN_LIGHT,
    "CoordinationBDIAgent",
    "StandardBDIAgent",
    { reason: "test_green_light" },
    { tick: 1, ttl: 10 }
  ));
  assert.equal(controller.movementBlocked({ type: "move" }), false);
});

test("HANDOFF CoordinationPlan fails with explicit unsupported reason", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });

  const result = controller.receiveCoordinationPlan({
    id: "handoff-plan",
    missionId: "mission-handoff",
    type: MISSION_TYPES.HANDOFF,
    roles: { "standard-bdi-agent": { type: MISSION_TYPES.HANDOFF } },
    phases: [{ id: "handoff", type: MISSION_TYPES.HANDOFF }],
    ttl: 20
  }, "coordination-agent");
  const entry = controller.plans.get("handoff-plan");
  const failed = controller.outbox.find((message) => message.type === TEAM_MESSAGE_TYPES.MISSION_FAILED);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "handoff_not_supported_by_environment");
  assert.equal(entry.state, COORDINATION_STATES.FAILED);
  assert.equal(failed.payload.reason, "handoff_not_supported_by_environment");
});

test("CoordinationPlan ttl expiration fails the plan", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });
  controller.receiveCoordinationPlan(sampleCoordinationPlan({
    id: "ttl-plan",
    missionId: "mission-ttl",
    roles: { "standard-bdi-agent": { target: { x: 5, y: 5 }, maxDistance: 0 } },
    ttl: 1
  }), "coordination-agent", { ttl: 1, tick: 0 });

  beliefs.time = 2;
  controller.update();
  const entry = controller.plans.get("ttl-plan");
  const failed = controller.outbox.find((message) =>
    message.type === TEAM_MESSAGE_TYPES.MISSION_FAILED &&
    message.payload.coordinationPlanId === "ttl-plan"
  );

  assert.equal(entry.state, COORDINATION_STATES.FAILED);
  assert.equal(entry.reason, "coordination_plan_expired");
  assert.equal(failed.payload.reason, "coordination_plan_expired");
});

test("Level 3 completes only after local and teammate READY match active plan", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateMap(1, 1, [{ x: 0, y: 0, type: "3" }]);
  beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });
  controller.receiveCoordinationPlan(sampleCoordinationPlan({
    id: "both-ready-plan",
    missionId: "mission-both-ready",
    type: MISSION_TYPES.BOTH_NEAR_POSITION,
    roles: {
      "standard-bdi-agent": { type: MISSION_TYPES.BOTH_NEAR_POSITION, target: { x: 0, y: 0 }, maxDistance: 0 },
      "coordination-agent": { type: MISSION_TYPES.BOTH_NEAR_POSITION, target: { x: 0, y: 0 }, maxDistance: 0 }
    },
    ttl: 20
  }), "coordination-agent");

  controller.update();
  assert.equal(controller.plans.get("both-ready-plan").state, COORDINATION_STATES.WAITING_TEAMMATE);

  const wrong = controller.receiveTeamMessage(createTeamMessage(
    TEAM_MESSAGE_TYPES.RENDEZVOUS_READY,
    "CoordinationBDIAgent",
    "StandardBDIAgent",
    { missionId: "wrong-mission", coordinationPlanId: "wrong-plan", position: { x: 0, y: 0 } },
    { tick: beliefs.time, ttl: 20 }
  ));
  assert.equal(wrong.accepted, false);
  assert.equal(controller.plans.get("both-ready-plan").state, COORDINATION_STATES.WAITING_TEAMMATE);

  const ready = controller.receiveTeamMessage(createTeamMessage(
    TEAM_MESSAGE_TYPES.RENDEZVOUS_READY,
    "CoordinationBDIAgent",
    "StandardBDIAgent",
    { missionId: "mission-both-ready", coordinationPlanId: "both-ready-plan", position: { x: 0, y: 0 } },
    { tick: beliefs.time, ttl: 20 }
  ));
  const completed = controller.outbox.find((message) =>
    message.type === TEAM_MESSAGE_TYPES.MISSION_COMPLETED &&
    message.payload.coordinationPlanId === "both-ready-plan"
  );

  assert.equal(ready.accepted, true);
  assert.equal(controller.plans.get("both-ready-plan").state, COORDINATION_STATES.COMPLETED);
  assert.ok(completed);
});

test("expired READY is ignored and does not complete plan", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });
  controller.receiveCoordinationPlan(sampleCoordinationPlan({
    id: "expired-ready-plan",
    missionId: "mission-expired-ready",
    roles: {
      "standard-bdi-agent": { target: { x: 0, y: 0 }, maxDistance: 0 },
      "coordination-agent": { target: { x: 0, y: 0 }, maxDistance: 0 }
    },
    ttl: 20
  }), "coordination-agent", { tick: 0, ttl: 20 });
  controller.update();
  beliefs.time = 3;

  const result = controller.receiveTeamMessage(createTeamMessage(
    TEAM_MESSAGE_TYPES.RENDEZVOUS_READY,
    "CoordinationBDIAgent",
    "StandardBDIAgent",
    { missionId: "mission-expired-ready", coordinationPlanId: "expired-ready-plan", position: { x: 0, y: 0 } },
    { tick: 0, ttl: 1 }
  ));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "expired_team_message");
  assert.notEqual(controller.plans.get("expired-ready-plan").state, COORDINATION_STATES.COMPLETED);
});

test("invalid CoordinationPlan fails atomically", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateSelf({ id: "runtime-bdi", name: "bdi", x: 0, y: 0 });
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });

  const missingTarget = controller.receiveCoordinationPlan({
    id: "invalid-no-target",
    missionId: "mission-invalid-no-target",
    type: MISSION_TYPES.RENDEZVOUS,
    roles: { "standard-bdi-agent": { type: MISSION_TYPES.RENDEZVOUS } },
    phases: [{ id: "meet", type: MISSION_TYPES.RENDEZVOUS }]
  }, "coordination-agent");
  const missingRole = controller.receiveCoordinationPlan({
    id: "invalid-no-role",
    missionId: "mission-invalid-no-role",
    type: MISSION_TYPES.RENDEZVOUS,
    roles: { "coordination-agent": { type: MISSION_TYPES.RENDEZVOUS, target: { x: 1, y: 1 } } },
    phases: [{ id: "meet", type: MISSION_TYPES.RENDEZVOUS }]
  }, "coordination-agent");
  const unsupported = controller.receiveCoordinationPlan({
    id: "invalid-unsupported",
    missionId: "mission-invalid-unsupported",
    type: "UNSUPPORTED_MACRO",
    roles: { "standard-bdi-agent": { type: "UNSUPPORTED_MACRO" } },
    phases: [{ id: "bad", type: "UNSUPPORTED_MACRO" }]
  }, "coordination-agent");

  assert.equal(missingTarget.accepted, false);
  assert.equal(controller.plans.get("invalid-no-target").state, COORDINATION_STATES.FAILED);
  assert.equal(missingRole.reason, "not_assigned");
  assert.equal(controller.plans.has("invalid-no-role"), false);
  assert.equal(unsupported.accepted, false);
  assert.equal(controller.plans.get("invalid-unsupported").state, COORDINATION_STATES.FAILED);
  assert.equal([...controller.plans.values()].some((entry) => entry.state === COORDINATION_STATES.ACCEPTED), false);
});

test("MissionSpec STACK_EXACTLY_N is registered", () => {
  const beliefs = {
    time: 10,
    pushEvent() {},
    markDirty() {}
  };
  const registry = new MissionRegistry({ beliefs });
  const mission = registry.addMission({
    type: MISSION_TYPES.STACK_EXACTLY_N,
    count: 2,
    multiplier: 2,
    hard: true,
    reason: "test_exact_stack"
  });
  const rules = registry.activeDeliveryRules(10);
  assert.equal(mission.type, MISSION_TYPES.STACK_EXACTLY_N);
  assert.equal(mission.constraints[0].multiplier, 2);
  assert.equal(mission.rewardModifiers[0].multiplier, 2);
  assert.equal(rules.stackRules[0].count, 2);
  assert.equal(rules.stackRules[0].hard, true);
  assert.equal(rules.stackRules[0].multiplier, 2);
});

test("evaluateDelivery applies hard exact stack multiplier only when count matches", () => {
  const mismatch = evaluateDelivery({
    state: { stackRules: [{ kind: "STACK_EXACTLY_N", count: 3, hard: true, multiplier: 2 }] },
    packages: [
      { valueAtPickup: 10, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 5, pickupTime: 0, decayRate: 0 }
    ],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.value, 0);

  const matched = evaluateDelivery({
    state: { stackRules: [{ kind: "STACK_EXACTLY_N", count: 3, hard: true, multiplier: 2 }] },
    packages: [
      { valueAtPickup: 10, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 5, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 2, pickupTime: 0, decayRate: 0 }
    ],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(matched.allowed, true);
  assert.equal(matched.multiplier, 2);
  assert.equal(matched.value, 34);
  assert.equal(matched.satisfiedRules.some((rule) => rule.kind === "STACK_EXACTLY_N"), true);
});

test("evaluateDelivery allows soft exact stack mismatch without bonus", () => {
  const result = evaluateDelivery({
    state: { stackRules: [{ kind: "STACK_EXACTLY_N", count: 3, hard: false, multiplier: 2 }] },
    packages: [
      { valueAtPickup: 10, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 5, pickupTime: 0, decayRate: 0 }
    ],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(result.allowed, true);
  assert.equal(result.multiplier, 1);
  assert.equal(result.value, 15);
  assert.equal(result.reason, "allowed_with_soft_rule_violations");
  assert.equal(result.violatedRules[0].hard, false);
});

test("evaluateDelivery allows hard exact stack match", () => {
  const result = evaluateDelivery({
    state: { stackRules: [{ kind: "STACK_EXACTLY_N", count: 2, hard: true }] },
    packages: [
      { valueAtPickup: 10, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 5, pickupTime: 0, decayRate: 0 }
    ],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(result.allowed, true);
  assert.equal(result.value, 15);
});

test("legacy delivery count multiplier remains compatible", () => {
  const result = evaluateDelivery({
    state: { deliveryCountMultipliers: { "2": { count: 2, multiplier: 3 } } },
    packages: [
      { valueAtPickup: 4, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 6, pickupTime: 0, decayRate: 0 }
    ],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(result.allowed, true);
  assert.equal(result.multiplier, 3);
  assert.equal(result.value, 30);
});

test("incompatible hard stack rules resolve by priority instead of blocking every delivery", () => {
  const state = {
    stackRules: [
      { kind: "STACK_EXACTLY_N", count: 2, hard: true, multiplier: 5, missionId: "old", priority: 1 },
      { kind: "STACK_EXACTLY_N", count: 3, hard: true, multiplier: 2, missionId: "new", priority: 2 }
    ]
  };

  const allowedWinner = evaluateDelivery({
    state,
    packages: [
      { valueAtPickup: 10, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 5, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 1, pickupTime: 0, decayRate: 0 }
    ],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(allowedWinner.allowed, true);
  assert.equal(allowedWinner.multiplier, 2);
  assert.equal(allowedWinner.conflicts[0].resolvedByMissionId, "new");
  assert.equal(allowedWinner.reason, "allowed_with_resolved_stack_conflict");

  const loserCount = evaluateDelivery({
    state,
    packages: [
      { valueAtPickup: 10, pickupTime: 0, decayRate: 0 },
      { valueAtPickup: 5, pickupTime: 0, decayRate: 0 }
    ],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(loserCount.allowed, false);
  assert.equal(loserCount.violatedRules[0].missionId, "new");
});

test("plan-search does not create red delivery step when hard stack rule is violated", () => {
  const state = parseMap({
    width: 2,
    height: 1,
    grid: [["3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    carriedPackages: [
      { packageId: "c1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, confidence: 1 },
      { packageId: "c2", valueAtPickup: 5, pickupTime: 0, decayRate: 0, confidence: 1 }
    ],
    stackRules: [{ kind: "STACK_EXACTLY_N", count: 3, hard: true, multiplier: 2 }],
    params: { ...CONFIG.planner, decayRate: 0 }
  });
  const red = { id: "R_1_0", type: "red", position: { x: 1, y: 0 } };
  const points = [
    { id: "START", type: "start", position: state.me.position },
    red
  ];
  const oracle = buildDistanceOracle(state, points);
  const plan = initialPlan(state);

  assert.equal(extendToRed(plan, red, state, oracle, state.params), null);
});

test("planner does not deliver when hard stack rule is violated", () => {
  const plannerState = parseMap({
    width: 3,
    height: 1,
    grid: [["3", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    carriedPackages: [{ packageId: "c1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, confidence: 1 }],
    stackRules: [{ kind: "STACK_EXACTLY_N", count: 2, hard: true, multiplier: 2 }],
    params: { ...CONFIG.planner, decayRate: 0 }
  });
  const deliveryDecision = shouldDeliverNow(plannerState, null, plannerState.params);
  plannerState.deliveryDecision = deliveryDecision;
  const routePlan = replan(plannerState, { deliveryDecision });

  assert.equal(deliveryDecision.deliveryForbidden, true);
  assert.notEqual(routePlan.sequence.at(-1), "R_2_0");
});

test("planner delivers when hard stack rule is satisfied", () => {
  const plannerState = parseMap({
    width: 3,
    height: 1,
    grid: [["3", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    carriedPackages: [
      { packageId: "c1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, confidence: 1 },
      { packageId: "c2", valueAtPickup: 5, pickupTime: 0, decayRate: 0, confidence: 1 }
    ],
    stackRules: [{ kind: "STACK_EXACTLY_N", count: 2, hard: true, multiplier: 2 }],
    params: { ...CONFIG.planner, decayRate: 0 }
  });
  const deliveryDecision = shouldDeliverNow(plannerState, null, plannerState.params);
  plannerState.deliveryDecision = deliveryDecision;
  const routePlan = replan(plannerState, { deliveryDecision });

  assert.equal(deliveryDecision.deliveryForbidden, false);
  assert.equal(deliveryDecision.shouldDeliver, true);
  assert.equal(routePlan.sequence.at(-1), "R_2_0");
});

test("reactive put_down on red only fires when delivery is allowed", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "2" },
    { x: 1, y: 0, type: "3" }
  ]);
  beliefs.updateSelf({ id: "me", x: 0, y: 0 });
  beliefs.carriedParcels.set("p1", { id: "p1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, x: 0, y: 0 });

  const allowed = tryImmediateAction({ beliefs, config: CONFIG });
  assert.equal(allowed.action.type, "put_down");

  beliefs.missionRegistry.addMission({
    type: MISSION_TYPES.STACK_EXACTLY_N,
    count: 2,
    hard: true
  });
  const rejected = tryImmediateAction({ beliefs, config: CONFIG });
  assert.equal(rejected, null);

  beliefs.carriedParcels.set("p2", { id: "p2", valueAtPickup: 5, pickupTime: 0, decayRate: 0, x: 0, y: 0 });
  const satisfied = tryImmediateAction({ beliefs, config: CONFIG });
  assert.equal(satisfied.action.type, "put_down");
});

test("immediate pickup chooses visible nearby parcel", () => {
  const plannerState = parseMap({
    width: 4,
    height: 1,
    grid: [["3", "1", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    parcels: [{ id: "p1", x: 1, y: 0, reward: 10, confidence: 1 }],
    params: { ...CONFIG.planner, decayRate: 0, immediatePickupMaxDistance: 4 }
  });
  const plan = buildImmediatePickupPlan(plannerState, plannerState.params);
  assert.ok(plan);
  assert.equal(plan.executablePlan.at(-1).type, "pick_up");
  assert.equal(plan.routePlan.candidateGreens[0].position.x, 1);
});

test("reactive stale pick_up from current plan is rejected", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateMap(1, 1, [{ x: 0, y: 0, type: "1" }]);
  beliefs.updateSelf({ id: "me", x: 0, y: 0 });
  beliefs.updateParcelsSensing([{ id: "p1", x: 0, y: 0, reward: 10 }], [{ x: 0, y: 0 }]);
  beliefs.updateParcelsSensing([], [{ x: 0, y: 0 }]);

  const reactive = tryImmediateAction({
    beliefs,
    currentRoutePlan: { mode: "PICKUP_DELIVERY_UNIFIED" },
    currentExecutablePlan: [{ type: "pick_up", at: { x: 0, y: 0 }, targetId: "G_0_0" }],
    actionIndex: 0,
    config: CONFIG
  });

  assert.equal(reactive.invalidCurrentPlan, true);
  assert.equal(reactive.reason, "pickup_parcel_unavailable");
});

test("reactive move toward forbidden tile is rejected", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" }
  ]);
  beliefs.updateSelf({ id: "me", x: 0, y: 0 });
  beliefs.setForbiddenTile({ x: 1, y: 0 }, { reason: "test_forbidden" });

  const reactive = tryImmediateAction({
    beliefs,
    currentRoutePlan: { mode: "PICKUP_DELIVERY_UNIFIED" },
    currentExecutablePlan: [{ type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }],
    actionIndex: 0,
    config: CONFIG
  });

  assert.equal(reactive.invalidCurrentPlan, true);
  assert.equal(reactive.reason, "move_not_allowed");
});

test("executor busy does not invalidate plan as action_failed", async () => {
  const beliefs = new BeliefState(CONFIG);
  const loop = new AgentLoop(fakeSocket(), beliefs, CONFIG, { enableChatProcessor: false });
  const records = [];
  loop.telemetry = {
    record(type, payload) {
      records.push({ type, payload });
    },
    nextTick() {}
  };
  loop.executor.telemetry = loop.telemetry;
  loop.currentRoutePlan = { mode: "PICKUP_DELIVERY_UNIFIED", sequence: ["START", "R_1_0"] };
  loop.currentExecutablePlan = [{ type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }];
  loop.executor.busy = true;

  const result = await loop.executeImmediateAction(
    { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    "test_executor_busy"
  );

  assert.equal(result, false);
  assert.ok(loop.currentRoutePlan);
  assert.equal(records.some((entry) => entry.type === "executor_busy"), true);
  assert.equal(records.some((entry) => entry.type === "action_failed"), false);
});

test("delivery policy forbids hard exact stack mismatch", () => {
  const plannerState = parseMap({
    width: 5,
    height: 1,
    grid: [["3", "1", "1", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    carriedPackages: [{ packageId: "c1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, confidence: 1 }],
    parcels: [
      { id: "p1", x: 1, y: 0, reward: 10, confidence: 1, lastSeenTime: 0 },
      { id: "p2", x: 2, y: 0, reward: 10, confidence: 1, lastSeenTime: 0 }
    ],
    stackRules: [{ kind: "STACK_EXACTLY_N", count: 3, hard: true }],
    params: { ...CONFIG.planner, decayRate: 0 }
  });
  const decision = shouldDeliverNow(plannerState, null, plannerState.params);
  assert.equal(decision.shouldDeliver, false);
  assert.equal(decision.deliveryForbidden, true);
  assert.equal(decision.deliveryDeferred, false);
  assert.equal(decision.stackRuleStatus, "needs_more_packages");
  assert.equal(decision.reason, "stack_rule_not_satisfied_and_nearby_pickups");
});

test("delivery policy defers soft exact stack mismatch when nearby pickup is useful", () => {
  const plannerState = parseMap({
    width: 5,
    height: 1,
    grid: [["3", "1", "1", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    carriedPackages: [{ packageId: "c1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, confidence: 1 }],
    parcels: [
      { id: "p1", x: 1, y: 0, reward: 10, confidence: 1, lastSeenTime: 0 },
      { id: "p2", x: 2, y: 0, reward: 10, confidence: 1, lastSeenTime: 0 }
    ],
    stackRules: [{ kind: "STACK_EXACTLY_N", count: 3, hard: false, multiplier: 2 }],
    params: { ...CONFIG.planner, decayRate: 0 }
  });
  const decision = shouldDeliverNow(plannerState, null, plannerState.params);
  assert.equal(decision.shouldDeliver, false);
  assert.equal(decision.deliveryForbidden, false);
  assert.equal(decision.deliveryDeferred, true);
  assert.equal(decision.stackRuleStatus, "needs_more_packages");
  assert.equal(decision.reason, "stack_rule_not_satisfied_and_nearby_pickups");
});

test("deferred delivery falls back to red when no valid harvest exists", () => {
  const plannerState = parseMap({
    width: 4,
    height: 1,
    grid: [["3", "1", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    enemies: [{ id: "enemy", position: { x: 1, y: 0 }, speed: 1 }],
    carriedPackages: [{ packageId: "c1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, confidence: 1 }],
    parcels: [{ id: "p1", x: 1, y: 0, reward: 10, confidence: 1, lastSeenTime: 0 }],
    stackRules: [{ kind: "STACK_EXACTLY_N", count: 2, hard: false, multiplier: 2 }],
    params: {
      ...CONFIG.planner,
      decayRate: 0,
      kWin: 100,
      shortHarvestMinCandidates: 2,
      shortHarvestDepth: 2,
      shortHarvestBudgetMs: 20
    }
  });
  const deliveryDecision = shouldDeliverNow(plannerState, null, plannerState.params);
  plannerState.deliveryDecision = deliveryDecision;
  const harvestPlan = buildShortHarvestPlan(plannerState, deliveryDecision, plannerState.params);
  const routePlan = replan(plannerState, { deliveryDecision });

  assert.equal(deliveryDecision.deliveryDeferred, true);
  assert.equal(deliveryDecision.deliveryForbidden, false);
  assert.equal(harvestPlan, null);
  assert.equal(routePlan.sequence.at(-1), "R_3_0");
});

test("short harvest rollout builds pickup-pickup-deliver sequence for exact stack", () => {
  const plannerState = parseMap({
    width: 5,
    height: 1,
    grid: [["3", "1", "1", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    carriedPackages: [{ packageId: "c1", valueAtPickup: 10, pickupTime: 0, decayRate: 0, confidence: 1 }],
    parcels: [
      { id: "p1", x: 1, y: 0, reward: 10, confidence: 1, lastSeenTime: 0 },
      { id: "p2", x: 2, y: 0, reward: 10, confidence: 1, lastSeenTime: 0 }
    ],
    stackRules: [{ kind: "STACK_EXACTLY_N", count: 3, hard: true }],
    params: {
      ...CONFIG.planner,
      decayRate: 0,
      shortHarvestMinCandidates: 2,
      shortHarvestDepth: 3,
      shortHarvestBudgetMs: 20
    }
  });
  const deliveryDecision = shouldDeliverNow(plannerState, null, plannerState.params);
  plannerState.deliveryDecision = deliveryDecision;
  const harvestPlan = buildShortHarvestPlan(plannerState, deliveryDecision, plannerState.params);

  assert.ok(harvestPlan);
  assert.equal(harvestPlan.type, "SHORT_HARVEST");
  assert.equal(harvestPlan.mode, "PICKUP_DELIVERY_UNIFIED");
  assert.equal(harvestPlan.sequence.at(-1), "R_4_0");
  assert.equal(harvestPlan.sequence.filter((id) => id.startsWith("G_")).length, 2);
});

test("new map resets missions, overlays, manual tasks, team state, and delivery rules", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "2" }
  ]);
  beliefs.missionRegistry.addMission({ type: MISSION_TYPES.STACK_EXACTLY_N, count: 2, hard: true });
  beliefs.pushManualTask({ type: "goto_tile", payload: { target: { x: 1, y: 0 } } });
  beliefs.setForbiddenTile({ x: 1, y: 0 }, { reason: "old_map" });
  beliefs.setPickupTileMultiplier({ x: 0, y: 0 }, 2);
  beliefs.setDeliveryTileMultiplier({ x: 1, y: 0 }, 2);
  beliefs.setDeliveryCountMultiplier(2, 2);
  beliefs.markTemporaryBlocked({ x: 1, y: 0 });
  beliefs.updateTeamHeartbeat({
    agentId: "teammate",
    agentName: "CoordinationBDIAgent",
    role: "llm",
    position: { x: 1, y: 0 },
    carriedCount: 0,
    tick: beliefs.time
  }, { receivedAtTick: beliefs.time, ttl: 10 });

  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "2" }
  ]);

  assert.equal(beliefs.missionRegistry.activeMissions(beliefs.time).length, 0);
  assert.equal(beliefs.manualTasks.length, 0);
  assert.equal(beliefs.forbiddenTiles.size, 0);
  assert.equal(beliefs.pickupTileMultipliers.size, 0);
  assert.equal(beliefs.deliveryTileMultipliers.size, 0);
  assert.equal(beliefs.deliveryCountMultipliers.size, 0);
  assert.equal(beliefs.temporaryBlockedCells.size, 0);
  assert.equal(Object.keys(beliefs.teamState.teammates).length, 0);

  const evaluation = evaluateDelivery({
    state: { deliveryRules: beliefs.missionRegistry.activeDeliveryRules(beliefs.time) },
    packages: [{ valueAtPickup: 10, pickupTime: 0, decayRate: 0 }],
    deliveryTime: 0,
    deliveryPosition: { x: 2, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(evaluation.allowed, true);
  assert.equal(beliefs.isForbiddenTile({ x: 1, y: 0 }), false);
});

test("AgentLoop resets ZoneMemory and CoordinationController on new map", () => {
  const beliefs = new BeliefState(CONFIG);
  const controller = new CoordinationController({
    agentId: "StandardBDIAgent",
    aliases: ["standard-bdi-agent"],
    beliefs,
    missionRegistry: beliefs.missionRegistry
  });
  const loop = new AgentLoop(fakeSocket(), beliefs, CONFIG, {
    enableChatProcessor: false,
    coordinationController: controller
  });

  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" }
  ]);
  beliefs.updateSelf({ id: "me", x: 0, y: 0 });
  beliefs.updateParcelsSensing([{ id: "p1", x: 1, y: 0, reward: 10 }], [{ x: 1, y: 0 }]);
  loop.zoneMemory.updateFromBeliefs(beliefs);
  controller.receiveCoordinationPlan(sampleCoordinationPlan({
    id: "old-map-plan",
    roles: { "standard-bdi-agent": { target: { x: 1, y: 0 }, maxDistance: 0 } }
  }), "coordination-agent");
  assert.ok(loop.zoneMemory.zones.size > 0);
  assert.ok(controller.plans.size > 0);

  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "2" }
  ]);
  const events = beliefs.consumeEvents();
  loop.handleMapResetEvents(events);

  assert.equal(loop.zoneMemory.zones.size, 0);
  assert.equal(loop.zoneMemory.seenParcelIds.size, 0);
  assert.equal(loop.zoneMemory.pickedParcelIds.size, 0);
  assert.equal(controller.plans.size, 0);
  assert.equal(loop.currentRoutePlan, null);
});

test("planner continues after new map reset", () => {
  const beliefs = new BeliefState(CONFIG);
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "2" }
  ]);
  beliefs.missionRegistry.addMission({ type: MISSION_TYPES.STACK_EXACTLY_N, count: 2, hard: true });
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "me", x: 0, y: 0 });
  beliefs.updateParcelsSensing([{ id: "p1", x: 1, y: 0, reward: 10 }], [{ x: 1, y: 0 }]);
  const routePlan = replan(buildPlannerState(beliefs, CONFIG));

  assert.ok(routePlan);
  assert.notEqual(routePlan.mode, "IDLE");
});

test("zone memory scores useful stale reward zones above current zone", () => {
  const memory = new ZoneMemory({ zoneMemorySectorSize: 5, zoneMemoryReturnToRedWeight: 0.5 });
  const beliefs = {
    time: 20,
    me: { x: 0, y: 0 },
    tiles: new Map([
      ["0,0", { x: 0, y: 0, type: "3" }],
      ["10,0", { x: 10, y: 0, type: "1" }]
    ]),
    parcels: new Map([
      ["p1", { id: "p1", x: 10, y: 0, reward: 100, rewardAtLastSeen: 100, confidence: 1, lastSeenTime: 20 }]
    ]),
    carriedParcels: new Map(),
    agents: new Map()
  };
  memory.updateFromBeliefs(beliefs);
  const plannerState = parseMap({
    width: 15,
    height: 1,
    grid: [["3", "3", "3", "3", "3", "3", "3", "3", "3", "3", "1", "3", "3", "3", "2"]],
    me: { id: "me", position: { x: 0, y: 0 } },
    params: CONFIG.planner
  });
  const best = memory.bestZone(plannerState);
  assert.equal(best.zoneId, "Z_2_0");
  assert.ok(best.score > 0);
});

test("directed arrows still constrain movement", () => {
  const state = parseMap({
    width: 2,
    height: 2,
    grid: [
      [{ type: "arrow_right" }, "3"],
      ["3", "3"]
    ],
    me: { id: "me", position: { x: 0, y: 0 } }
  });
  assert.equal(isMoveAllowed(state, { x: 0, y: 0 }, { x: 1, y: 0 }), true);
  assert.equal(isMoveAllowed(state, { x: 0, y: 0 }, { x: 0, y: 1 }), false);
});

test("forbidden tile is avoided by pathfinder", () => {
  const state = parseMap({
    width: 3,
    height: 2,
    grid: [
      ["3", "3", "3"],
      ["3", "3", "3"]
    ],
    me: { id: "me", position: { x: 0, y: 0 } },
    forbiddenTiles: { "1,0": { x: 1, y: 0, reason: "test" } }
  });
  const path = shortestGridPath(state, { x: 0, y: 0 }, { x: 2, y: 0 });
  assert.ok(Number.isFinite(path.cost));
  assert.equal(path.path.some((position) => positionKey(position) === "1,0"), false);
});

test("team protocol parse/stringify roundtrip works", () => {
  const raw = stringifyTeamMessage({
    type: TEAM_MESSAGE_TYPES.MISSION_SPEC,
    from: "a",
    to: "b",
    tick: 4,
    ttl: 9,
    payload: { missionSpec: sampleMissionSpec({ assignedTo: "b" }) }
  });
  const parsed = parseTeamMessage(raw);
  assert.equal(parsed.protocol, "ASA_TEAM_V1");
  assert.equal(parsed.type, TEAM_MESSAGE_TYPES.MISSION_SPEC);
  assert.equal(parsed.payload.missionSpec.assignedTo, "b");
});
