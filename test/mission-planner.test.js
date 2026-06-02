import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CONFIG } from "../src/config.js";
import { normalizeActionDelayMs } from "../src/control/agent-loop.js";
import { createChatProcessor } from "../src/control/chat-processor.js";
import { stringifyTeamMessage, parseTeamMessage, TEAM_MESSAGE_TYPES } from "../src/communication/team-protocol.js";
import { evaluateDelivery } from "../src/missions/reward-model.js";
import { MissionRegistry } from "../src/missions/mission-registry.js";
import { MISSION_TYPES } from "../src/missions/mission-spec.js";
import { parseMap, replan, shortestGridPath, isMoveAllowed } from "../src/planner/route-planner.js";
import { buildImmediatePickupPlan, tryImmediateAction } from "../src/strategy/reactive-layer.js";
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
