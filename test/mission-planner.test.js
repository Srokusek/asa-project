import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CONFIG } from "../src/config.js";
import { normalizeActionDelayMs } from "../src/control/agent-loop.js";
import { createChatProcessor } from "../src/control/chat-processor.js";
import { createAgentForRole, normalizeAgentRole } from "../src/index.js";
import { createMessageRouter } from "../src/communication/message-router.js";
import { createTeamMessage, stringifyTeamMessage, parseTeamMessage, TEAM_MESSAGE_TYPES } from "../src/communication/team-protocol.js";
import { evaluateDelivery } from "../src/missions/reward-model.js";
import { MissionRegistry } from "../src/missions/mission-registry.js";
import { parseLlmMissionOutput } from "../src/missions/mission-parser.js";
import { MISSION_TYPES } from "../src/missions/mission-spec.js";
import { buildShortHarvestPlan } from "../src/planner/search/short-harvest-rollout.js";
import { parseMap, replan, shortestGridPath, isMoveAllowed } from "../src/planner/route-planner.js";
import { shouldDeliverNow } from "../src/strategy/delivery-policy.js";
import { buildImmediatePickupPlan, tryImmediateAction } from "../src/strategy/reactive-layer.js";
import { ZoneMemory } from "../src/strategy/zone-memory.js";
import { BeliefState } from "../src/state/belief-state.js";
import { positionKey } from "../src/utils/geometry.js";

process.env.CHAT_DIAGNOSTICS_ENABLED = "0";

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

test("ChatProcessor kick does not block on LLM work", async () => {
  let release;
  const llmCaller = () => new Promise((resolve) => {
    release = () => resolve({ message: { content: "ok" } });
  });
  const beliefs = {
    me: { id: "me" },
    time: 0,
    pendingChatMessages: (sinceChatId) => (sinceChatId < 1 ? [{ chatId: 1, fromId: "admin", text: "hello" }] : []),
    advanceTimeFromClock() {},
    pushEvent() {},
    markDirty() {}
  };
  const executor = { writeMessage: async () => true };
  const processor = createChatProcessor({ beliefs, executor, logger: logger(), llmCaller });

  const startedAt = Date.now();
  assert.equal(processor.kick(), true);
  assert.equal(processor.isInFlight(), true);
  assert.ok(Date.now() - startedAt < 20);
  assert.equal(processor.kick(), false);

  release();
  await processor.inFlightPromise();
  assert.equal(processor.isInFlight(), false);
});

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

test("MessageRouter keeps TeamProtocol separate from natural mission chat and deduplicates", () => {
  const router = createMessageRouter({ selfId: "bdi-1" });
  const teamMessage = createTeamMessage(
    TEAM_MESSAGE_TYPES.MISSION_SPEC,
    "coord",
    "bdi-1",
    { missionSpec: { type: MISSION_TYPES.GOTO_TILE, objective: { target: { x: 1, y: 2 } } } },
    { id: "msg-1", tick: 0, ttl: 10 }
  );

  assert.equal(router.routeIncomingChat({ fromId: "admin", text: "go to 1,2" }, 0).kind, "mission_text");
  assert.equal(router.routeIncomingChat({ fromId: "coord", text: JSON.stringify(teamMessage) }, 0).kind, "team");
  assert.equal(router.routeTeamMessage(teamMessage, 0).reason, "duplicate_team_message");
  assert.equal(router.consumeMissionMessages().length, 1);
  assert.equal(router.consumeTeamMessagesFor("bdi-1", 0).length, 1);
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

test("LlmCoordinationAgent receives MissionSpec while preserving BDI gameplay loop", async () => {
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
    hard: true,
    reason: "test_exact_stack"
  });
  const rules = registry.activeDeliveryRules(10);
  assert.equal(mission.type, MISSION_TYPES.STACK_EXACTLY_N);
  assert.equal(rules.stackRules[0].count, 2);
  assert.equal(rules.stackRules[0].hard, true);
});

test("evaluateDelivery rejects hard exact stack mismatch", () => {
  const result = evaluateDelivery({
    state: { stackRules: [{ kind: "STACK_EXACTLY_N", count: 2, hard: true }] },
    packages: [{ valueAtPickup: 10, pickupTime: 0, decayRate: 0 }],
    deliveryTime: 1,
    deliveryPosition: { x: 0, y: 0 },
    config: CONFIG.planner
  });
  assert.equal(result.allowed, false);
  assert.equal(result.value, 0);
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
  assert.equal(result.value, 30);
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

test("delivery policy defers when exact stack needs nearby packages", () => {
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
  assert.equal(decision.stackRuleStatus, "needs_more_packages");
  assert.equal(decision.reason, "stack_rule_not_satisfied_and_nearby_pickups");
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
    payload: { missionId: "m1" }
  });
  const parsed = parseTeamMessage(raw);
  assert.equal(parsed.protocol, "ASA_TEAM_V1");
  assert.equal(parsed.type, TEAM_MESSAGE_TYPES.MISSION_SPEC);
  assert.equal(parsed.payload.missionId, "m1");
});

test("chat:llm script points to a real file", () => {
  assert.equal(existsSync(new URL("../src/llm-chat-agent.js", import.meta.url)), true);
});
