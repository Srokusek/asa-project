import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CONFIG } from "../src/config.js";
import { AgentLoop, compactSequence, routePathIsExecutable } from "../src/control/agent-loop.js";
import { Executor } from "../src/executor/executor.js";
import { BeliefState } from "../src/state/belief-state.js";
import { registerSdkListeners } from "../src/state/sdk-adapter.js";

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.position = { x: 0, y: 0 };
    this.carried = [];
    this.records = [];
    this.failNextMove = false;
    this.failMovesRemaining = 0;
    this.failNextPickup = false;
    this.pickupReward = null;
  }

  async emitMove(direction) {
    this.records.push({ type: "move", direction });
    if (this.failNextMove || this.failMovesRemaining > 0) {
      this.failNextMove = false;
      this.failMovesRemaining = Math.max(0, this.failMovesRemaining - 1);
      return false;
    }
    if (direction === "right") this.position.x += 1;
    if (direction === "left") this.position.x -= 1;
    if (direction === "up") this.position.y += 1;
    if (direction === "down") this.position.y -= 1;
    return { ...this.position };
  }

  async emitPickup() {
    this.records.push({ type: "pick_up" });
    if (this.failNextPickup) {
      this.failNextPickup = false;
      return [];
    }
    if (this.position.x === 1 && this.position.y === 0) {
      this.carried = [
        this.pickupReward === null ? { id: "P" } : { id: "P", reward: this.pickupReward }
      ];
      return this.carried;
    }
    return [];
  }

  async emitPutdown() {
    this.records.push({ type: "put_down" });
    if (this.position.x === 2 && this.position.y === 0 && this.carried.length > 0) {
      const delivered = this.carried;
      this.carried = [];
      return delivered;
    }
    return [];
  }
}

function config() {
  return {
    ...CONFIG,
    actionDelayMs: 0,
    logLevel: "silent",
    planner: {
      ...CONFIG.planner,
      decayRate: 0,
      moveWeight: 1,
      betaCarry: 1,
      periodicReplanTicks: 100
    }
  };
}

function emitInitialWorld(socket) {
  socket.emit("you", { id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  socket.emit("map", 3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  socket.emit("parcelsSensing", [{ id: "P", x: 1, y: 0, reward: 20 }]);
}

test("mock agent builds plan and executes move, pick_up, put_down", async () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  registerSdkListeners(socket, beliefs, loop);
  emitInitialWorld(socket);

  await loop.tick();
  await loop.tick();
  await loop.tick();
  await loop.tick();

  assert.deepEqual(
    socket.records.map((record) => record.type),
    ["move", "pick_up", "move", "put_down"]
  );
});

test("move false pushes failure events and invalidates current plan", async () => {
  const socket = new MockSocket();
  socket.failNextMove = true;
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  registerSdkListeners(socket, beliefs, loop);
  emitInitialWorld(socket);

  await loop.tick();

  assert.equal(loop.currentRoutePlan, null);
  assert.ok(beliefs.events.some((event) => event.type === "PATH_BLOCKED"));
  assert.ok(beliefs.temporaryBlockedCells.has("1,0"));

  await loop.tick();
  assert.equal(socket.records.filter((record) => record.type === "move").length, 1);
});

test("move false marks the target cell as temporarily blocked", async () => {
  const socket = new MockSocket();
  socket.failNextMove = true;
  const beliefs = new BeliefState(config());
  const executor = new Executor(socket, beliefs, config());

  await executor.execute({
    type: "move",
    direction: "right",
    from: { x: 1, y: 1 },
    to: { x: 2, y: 1 }
  });

  assert.ok(beliefs.temporaryBlockedCells.has("2,1"));
  assert.ok(beliefs.isTemporarilyBlockedEdge({ x: 1, y: 1 }, { x: 2, y: 1 }));
  assert.ok(beliefs.events.some((event) => event.type === "MOVE_FAILED" && event.payload.blockedCell));
});

test("executor records emit timing for move pickup and putdown", async () => {
  const socket = new MockSocket();
  socket.position = { x: 0, y: 0 };
  const beliefs = new BeliefState(config());
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.parcels.set("P", { id: "P", x: 1, y: 0, reward: 10, confidence: 1 });
  const records = [];
  const telemetry = { record: (event, payload) => records.push({ event, payload }) };
  const executor = new Executor(socket, beliefs, config(), telemetry, { info: () => {}, warn: () => {} });

  await executor.execute({ type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
  await executor.execute({ type: "pick_up", at: { x: 1, y: 0 }, targetId: "G" });
  await executor.execute({ type: "move", direction: "right", from: { x: 1, y: 0 }, to: { x: 2, y: 0 } });
  await executor.execute({ type: "put_down", parcels: "all" });

  assert.equal(typeof records.find((record) => record.event === "move")?.payload.emitMoveMs, "number");
  assert.equal(typeof records.find((record) => record.event === "pick_up")?.payload.emitPickupMs, "number");
  assert.equal(typeof records.find((record) => record.event === "put_down")?.payload.emitPutdownMs, "number");
});

test("repeated move failures escalate and leave a sidestep option", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  beliefs.updateMap(3, 2, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "3" },
    { x: 0, y: 1, type: "3" },
    { x: 1, y: 1, type: "3" },
    { x: 2, y: 1, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 1, y: 0, score: 0, penalty: 0 });
  const loop = new AgentLoop(socket, beliefs, config());
  const action = {
    type: "move",
    direction: "right",
    from: { x: 1, y: 0 },
    to: { x: 2, y: 0 }
  };

  loop.recordMoveFailure(action);
  loop.recordMoveFailure(action);
  loop.recordMoveFailure(action);
  const sidestep = loop.explorationAction();

  assert.equal(loop.consecutiveMoveFailures, 3);
  assert.ok(beliefs.temporaryBlockedCells.has("2,0"));
  assert.ok(sidestep);
  assert.notDeepEqual(sidestep.to, action.to);
});

test("successful pick_up continues the current plan without automatic replan", async () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  registerSdkListeners(socket, beliefs, loop);
  emitInitialWorld(socket);

  await loop.tick();

  const originalMakePlan = loop.makePlan.bind(loop);
  let replanCount = 0;
  loop.makePlan = (events = []) => {
    replanCount += 1;
    return originalMakePlan(events);
  };

  await loop.tick();
  await loop.tick();

  assert.equal(replanCount, 0);
  assert.deepEqual(
    socket.records.map((record) => record.type),
    ["move", "pick_up", "move"]
  );
});

test("pickup failure invalidates the plan and queues a replan trigger", async () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  registerSdkListeners(socket, beliefs, loop);
  emitInitialWorld(socket);

  await loop.tick();
  socket.failNextPickup = true;
  await loop.tick();

  assert.equal(loop.currentRoutePlan, null);
  assert.ok(beliefs.events.some((event) => event.type === "PICKUP_FAILED"));
  assert.ok(beliefs.events.some((event) => event.type === "TARGET_NOT_FOUND"));
});

test("AGENTS_SENSING replans only when the enemy intersects the near path", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());

  loop.currentRoutePlan = { config: { periodicReplanTicks: 100 } };
  loop.currentExecutablePlan = [
    { type: "move", to: { x: 1, y: 0 } },
    { type: "pick_up", at: { x: 1, y: 0 } },
    { type: "move", to: { x: 2, y: 0 } }
  ];
  loop.actionIndex = 0;
  loop.lastPlanTime = beliefs.time;

  beliefs.agents.set("far", { id: "far", x: 9, y: 9, confidence: 1 });
  assert.equal(loop.mustReplan([{ type: "AGENTS_SENSING" }]), false);

  beliefs.agents.set("near", { id: "near", x: 1, y: 0, confidence: 1 });
  assert.equal(loop.mustReplan([{ type: "AGENTS_SENSING" }]), true);
});

function setScoutPlan(loop, { remaining = 10, periodicReplanTicks = 1 } = {}) {
  loop.currentRoutePlan = {
    mode: "SCOUT",
    sequence: ["START", "SCOUT_CLUSTER"],
    path: Array.from({ length: remaining + 1 }, (_, index) => ({ x: index, y: 0 })),
    scoutTarget: {
      id: "CLUSTER",
      position: { x: remaining, y: 0 }
    },
    config: { periodicReplanTicks }
  };
  loop.currentExecutablePlan = Array.from({ length: remaining }, (_, index) => ({
    type: "move",
    direction: "right",
    from: { x: index, y: 0 },
    to: { x: index + 1, y: 0 }
  }));
  loop.actionIndex = 0;
}

test("SCOUT commitment ignores soft sensing events while actions remain", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  setScoutPlan(loop);
  loop.lastPlanTime = 0;
  beliefs.time = 50;
  beliefs.agents.set("far", { id: "far", x: 9, y: 9, confidence: 1 });

  const should = loop.mustReplan([
    { type: "PARCELS_SENSING", payload: { count: 0 } },
    { type: "YOU_UPDATED" },
    { type: "AGENTS_SENSING", payload: { count: 1 } }
  ]);

  assert.equal(should, false);
  assert.equal(loop.lastReplanCause, "scout_commitment_keep_plan");
});

test("SCOUT commitment is interrupted by a new package", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  setScoutPlan(loop);

  assert.equal(loop.mustReplan([{ type: "NEW_PACKAGE_SPAWN", payload: { id: "P" } }]), true);
  assert.equal(loop.lastReplanCause, "new_package");
});

test("SCOUT commitment is interrupted by a relevant enemy on the path", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  setScoutPlan(loop);
  beliefs.agents.set("near", { id: "near", x: 1, y: 0, confidence: 1 });

  assert.equal(loop.mustReplan([{ type: "AGENTS_SENSING", payload: { count: 1 } }]), true);
  assert.equal(loop.lastReplanCause, "enemy_relevant");
});

test("SCOUT commitment is not interrupted by periodic replanning", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  setScoutPlan(loop, { periodicReplanTicks: 1 });
  loop.lastPlanTime = 0;
  beliefs.time = 100;

  assert.equal(loop.mustReplan([]), false);
  assert.equal(loop.lastReplanCause, "scout_commitment_keep_plan");
});

test("GREEN_EXPOSURE_SCOUT commitment ignores empty soft updates", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  loop.currentRoutePlan = {
    mode: "GREEN_EXPOSURE_SCOUT",
    sequence: ["START", "GREEN_EXPOSURE_3_0"],
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
    scoutTarget: { id: "GREEN_EXPOSURE_3_0", position: { x: 3, y: 0 } },
    config: { periodicReplanTicks: 1 }
  };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { type: "move", direction: "right", from: { x: 1, y: 0 }, to: { x: 2, y: 0 } },
    { type: "move", direction: "right", from: { x: 2, y: 0 }, to: { x: 3, y: 0 } }
  ];
  loop.actionIndex = 0;
  loop.lastPlanTime = 0;
  beliefs.time = 100;

  assert.equal(
    loop.mustReplan([
      { type: "YOU_UPDATED" },
      { type: "PARCELS_SENSING", payload: { count: 0 } }
    ]),
    false
  );
  assert.equal(loop.lastReplanCause, "scout_commitment_keep_plan");
});

test("event coalescing compacts repeated soft events into one batch", () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: { ...config().planner, eventCoalesceMs: 50 }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  const events = [];
  for (let i = 0; i < 4; i += 1) events.push({ type: "AGENTS_SENSING", payload: { count: 1 } });
  for (let i = 0; i < 4; i += 1) events.push({ type: "PARCELS_SENSING", payload: { count: 0 } });
  for (let i = 0; i < 2; i += 1) events.push({ type: "YOU_UPDATED" });

  loop.queueEvents(events);
  const batch = loop.flushPendingEvents({ force: true });

  assert.equal(batch.length, 3);
  assert.equal(batch.find((event) => event.type === "AGENTS_SENSING").count, 4);
  assert.equal(batch.find((event) => event.type === "PARCELS_SENSING").count, 4);
  assert.equal(batch.find((event) => event.type === "YOU_UPDATED").count, 2);
});

test("replan throttling keeps a valid plan through repeated YOU_UPDATED events", () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: { ...config().planner, minReplanIntervalMs: 1000 }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  loop.currentRoutePlan = {
    mode: "PICKUP_ONLY",
    sequence: ["START", "G"],
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }]
  };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }
  ];
  loop.actionIndex = 0;
  loop.lastReplanWallClockMs = Date.now();

  assert.equal(loop.mustReplan([{ type: "YOU_UPDATED", count: 10 }]), false);
  assert.equal(loop.lastReplanCause, "replan_throttled");
});

test("routePathIsExecutable rejects walkable paths with illegal arrow edges", () => {
  const state = {
    grid: [[
      { type: "normal", blocked: false, cost: 1 },
      { type: "special", blocked: false, cost: 1, directionConstraint: "left" },
      { type: "normal", blocked: false, cost: 1 }
    ]],
    width: 3,
    height: 1
  };

  assert.equal(
    routePathIsExecutable({
      state,
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]
    }),
    false
  );
});

test("immediate nearby pickup chooses a visible package before scout planning", () => {
  const socket = new MockSocket();
  const cfg = config();
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);

  const immediate = loop.tryImmediateNearbyPickup();

  assert.equal(immediate.routePlan.mode, "PICKUP_DELIVERY");
  assert.equal(immediate.routePlan.fallbackStage, "immediate_nearby_pickup");
  assert.ok(immediate.executablePlan.some((action) => action.type === "pick_up"));
});

test("nearby pickup preempts GREEN_EXPOSURE_SCOUT in tick", async () => {
  const socket = new MockSocket();
  const cfg = config();
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  registerSdkListeners(socket, beliefs, loop);
  socket.emit("you", { id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  socket.emit("map", 3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.consumeEvents();
  loop.currentRoutePlan = {
    mode: "GREEN_EXPOSURE_SCOUT",
    sequence: ["START", "GREEN_EXPOSURE_2_0"],
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    state: null,
    config: { periodicReplanTicks: 100 }
  };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { type: "move", direction: "right", from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
  ];
  socket.emit("parcelsSensing", [{ id: "P", x: 1, y: 0, reward: 20 }]);

  await loop.tick();

  assert.equal(loop.currentRoutePlan.mode, "PICKUP_DELIVERY");
  assert.equal(loop.currentRoutePlan.fallbackStage, "immediate_nearby_pickup");
  assert.deepEqual(socket.records.map((record) => record.type), ["move"]);
});

test("delivery-only is not interrupted by a low value nearby package", () => {
  const socket = new MockSocket();
  const cfg = config();
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(4, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "3" },
    { x: 3, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.carriedParcels.set("C", { id: "C", valueAtPickup: 30, pickupTime: 0, decayRate: 0, confidence: 1 });
  beliefs.updateParcelsSensing([{ id: "LOW", x: 1, y: 0, reward: 1 }], [{ x: 1, y: 0 }]);
  loop.currentRoutePlan = { mode: "DELIVERY_ONLY" };
  loop.currentExecutablePlan = [{ type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }];

  assert.equal(loop.tryImmediateNearbyPickup(), null);
});

test("enemy in next cell prevents emitMove and marks a temporary block", async () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.agents.set("E", { id: "E", x: 1, y: 0, confidence: 1 });
  beliefs.consumeEvents();
  loop.currentRoutePlan = { mode: "LOCAL_EXPLORE", sequence: ["START", "EXPLORE"], config: { periodicReplanTicks: 100 } };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }
  ];
  loop.actionIndex = 0;
  loop.lastPlanTime = beliefs.time;

  await loop.tick();

  assert.equal(socket.records.length, 0);
  assert.ok(beliefs.temporaryBlockedCells.has("1,0"));
  assert.ok(beliefs.isTemporarilyBlockedEdge({ x: 0, y: 0 }, { x: 1, y: 0 }));
  assert.equal(loop.currentRoutePlan, null);
});

test("pickup fallback uses reward returned by the SDK result", async () => {
  const beliefs = new BeliefState(config());
  beliefs.updateSelf({ id: "ME", name: "me", x: 1, y: 0, score: 0, penalty: 0 });
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  const socket = {
    async emitPickup() {
      return [{ id: "P_server", reward: 77 }];
    }
  };
  const executor = new Executor(socket, beliefs, config());

  await executor.pickUp({ targetId: "G_1_0", at: { x: 1, y: 0 } });

  assert.equal(beliefs.carriedParcels.get("P_server").valueAtPickup, 77);
});

test("START-only empty plan stays idle without invalidate loop", async () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());

  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.consumeEvents();

  loop.currentRoutePlan = { mode: "IDLE", sequence: ["START"], config: { periodicReplanTicks: 100 } };
  loop.currentExecutablePlan = [];
  loop.actionIndex = 0;
  loop.lastPlanTime = beliefs.time;

  let invalidations = 0;
  const originalInvalidate = loop.invalidatePlan.bind(loop);
  loop.invalidatePlan = (reason) => {
    invalidations += 1;
    return originalInvalidate(reason);
  };

  await loop.tick();
  await loop.tick();

  assert.equal(invalidations, 0);
  assert.deepEqual(loop.currentRoutePlan.sequence, ["START"]);
  assert.deepEqual(loop.currentExecutablePlan, []);
});

test("completed scout plan records the visited scout target", async () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  registerSdkListeners(socket, beliefs, loop);

  socket.emit("you", { id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  socket.emit("map", 2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" }
  ]);

  await loop.tick();

  assert.ok(beliefs.visitedGreenAt.has("G_1_0"));
  assert.equal(socket.records.some((record) => record.type === "pick_up"), false);
});

test("scout target is marked visited when entering sensing range before completion", async () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: {
      ...config().planner,
      sensingRange: 1
    }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "1" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.consumeEvents();
  setScoutPlan(loop, { remaining: 2, periodicReplanTicks: 100 });
  loop.currentRoutePlan.scoutTarget = { id: "CLUSTER", position: { x: 2, y: 0 } };
  loop.lastPlanTime = beliefs.time;

  await loop.tick();

  assert.equal(beliefs.greenRecentlyVisited("CLUSTER", cfg.planner.scoutCooldownTicks), true);
  assert.equal(loop.currentRoutePlan?.mode, "SCOUT");
});

test("replan log separates events seen from the replan cause", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  loop.lastReplanCause = "missing_plan";
  let replanPayload = null;
  loop.logger.info = (message, payload) => {
    if (message === "replan") replanPayload = payload;
  };

  loop.makePlan([{ type: "MAP_READY" }]);

  assert.equal(replanPayload.eventsSeen, "MAP_READYx1");
  assert.equal(replanPayload.replanCause, "missing_plan");
  assert.equal(typeof replanPayload.buildPlannerStateMs, "number");
  assert.equal(typeof replanPayload.replanMs, "number");
  assert.equal(typeof replanPayload.buildExecutablePlanMs, "number");
  assert.equal(typeof replanPayload.totalPlanningMs, "number");
});

test("replan log includes candidate diagnostics when full pickup plan fails", () => {
  const socket = new MockSocket();
  const cfg = config();
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(4, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "3" },
    { x: 3, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateAgentsSensing([{ id: "E", x: 1, y: 0, score: 0 }]);
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 30 }], [{ x: 1, y: 0 }]);
  loop.lastReplanCause = "missing_plan";
  let replanPayload = null;
  loop.logger.info = (message, payload) => {
    if (message === "replan") replanPayload = payload;
  };

  loop.makePlan([{ type: "PARCELS_SENSING", payload: { count: 1 } }]);

  assert.equal(replanPayload.invalidPlanDetected, true);
  assert.equal(replanPayload.fallbackStage, "pickup_only");
  assert.equal(replanPayload.candidateDiagnostics.length, 1);
  assert.equal(replanPayload.candidateDiagnostics[0].rejectionReason, "enemy_wins_race");
});

test("replan log reports visible packages ignored by candidate selection", () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: {
      ...config().planner,
      topK: 1,
      localCandidateLimit: 0,
      clusterExpansionLimit: 0,
      maxCandidateGreens: 1
    }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(5, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "1" },
    { x: 3, y: 0, type: "3" },
    { x: 4, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing(
    [
      { id: "HIGH", x: 1, y: 0, reward: 50 },
      { id: "LOW", x: 2, y: 0, reward: 5 }
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 }
    ]
  );
  let replanPayload = null;
  loop.logger.info = (message, payload) => {
    if (message === "replan") replanPayload = payload;
  };

  loop.makePlan([{ type: "PARCELS_SENSING", payload: { count: 2 } }]);

  assert.equal(replanPayload.visiblePackagesCount, 2);
  assert.equal(replanPayload.candidatePackagesCount, 1);
  assert.equal(replanPayload.ignoredVisiblePackages.length, 1);
  assert.equal(replanPayload.ignoredVisiblePackages[0].id, "LOW");
  assert.equal(replanPayload.ignoredVisiblePackages[0].reason, "not_candidate");
});

test("repeated blocked move guard logs after the configured threshold", async () => {
  const socket = new MockSocket();
  socket.failMovesRemaining = 2;
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.consumeEvents();
  const action = { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
  const warnings = [];
  loop.logger.warn = (message, payload) => warnings.push({ message, payload });

  for (let i = 0; i < 2; i += 1) {
    loop.currentRoutePlan = { mode: "LOCAL_EXPLORE", sequence: ["START", "EXPLORE"], config: { periodicReplanTicks: 100 } };
    loop.currentExecutablePlan = [action];
    loop.actionIndex = 0;
    loop.lastPlanTime = beliefs.time;
    await loop.tick();
    if (i === 0) beliefs.consumeEvents();
  }

  assert.equal(loop.sameBlockedMoveCount, 2);
  assert.ok(warnings.some((warning) => warning.message === "repeatedBlockedMove"));
  assert.equal(loop.currentRoutePlan, null);
});

test("compact sequence logging omits huge middle sections", () => {
  const sequence = ["START", ...Array.from({ length: 20 }, (_, index) => `G_${index}`), "R"];
  const compact = compactSequence(sequence);

  assert.equal(compact.sequenceLength, sequence.length);
  assert.equal(compact.truncated, true);
  assert.equal(compact.text.includes("G_10"), false);
  assert.ok(compact.text.startsWith("START -> G_0 -> G_1 -> ... -> R"));
  assert.ok(compact.text.length < sequence.join(" -> ").length);
});

test("opportunistic pickup diverts to a high reward parcel near the current path", () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: {
      ...config().planner,
      opportunisticMinGain: 5,
      opportunisticPathRadius: 2,
      opportunisticMaxDistance: 3,
      moveWeight: 1,
      decayRate: 0
    }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(4, 3, [
    { x: 0, y: 1, type: "3" },
    { x: 1, y: 1, type: "3" },
    { x: 2, y: 1, type: "3" },
    { x: 3, y: 1, type: "2" },
    { x: 1, y: 2, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 1, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "SIDE", x: 1, y: 2, reward: 40 }], [{ x: 1, y: 2 }]);
  loop.currentRoutePlan = {
    mode: "DELIVERY_ONLY",
    sequence: ["START", "R"],
    path: [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 }
    ]
  };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 1 }, to: { x: 1, y: 1 } },
    { type: "move", direction: "right", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
    { type: "move", direction: "right", from: { x: 2, y: 1 }, to: { x: 3, y: 1 } },
    { type: "put_down", at: { x: 3, y: 1 }, parcels: "all" }
  ];
  loop.actionIndex = 0;

  const opportunistic = loop.findOpportunisticPickup();

  assert.ok(opportunistic);
  assert.equal(opportunistic.routePlan.mode, "OPPORTUNISTIC_PICKUP");
  assert.ok(opportunistic.executablePlan.some((action) => action.type === "pick_up"));
});

test("opportunistic pickup ignores a low reward parcel near the path", () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: {
      ...config().planner,
      opportunisticMinGain: 20,
      opportunisticPathRadius: 2,
      opportunisticMaxDistance: 3,
      moveWeight: 1,
      decayRate: 0
    }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(4, 3, [
    { x: 0, y: 1, type: "3" },
    { x: 1, y: 1, type: "3" },
    { x: 2, y: 1, type: "3" },
    { x: 3, y: 1, type: "2" },
    { x: 1, y: 2, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 1, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "LOW", x: 1, y: 2, reward: 3 }], [{ x: 1, y: 2 }]);
  loop.currentRoutePlan = { mode: "DELIVERY_ONLY", sequence: ["START", "R"], path: [{ x: 0, y: 1 }, { x: 3, y: 1 }] };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 1 }, to: { x: 1, y: 1 } },
    { type: "move", direction: "right", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
    { type: "move", direction: "right", from: { x: 2, y: 1 }, to: { x: 3, y: 1 } }
  ];
  loop.actionIndex = 0;

  assert.equal(loop.findOpportunisticPickup(), null);
});

test("AgentLoop does not use fallback exploration for invalid pickup plans", async () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.consumeEvents();
  loop.currentRoutePlan = {
    mode: "PICKUP_DELIVERY",
    sequence: ["START"],
    path: [{ x: 0, y: 0 }],
    candidateGreens: [{ id: "G_1_0" }],
    config: { periodicReplanTicks: 100 }
  };
  loop.currentExecutablePlan = [];
  loop.actionIndex = 0;
  loop.lastPlanTime = beliefs.time;
  let explorationCalls = 0;
  loop.explorationAction = () => {
    explorationCalls += 1;
    return { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
  };
  let invalidationReason = null;
  const originalInvalidate = loop.invalidatePlan.bind(loop);
  loop.invalidatePlan = (reason) => {
    invalidationReason = reason;
    return originalInvalidate(reason);
  };

  await loop.tick();

  assert.equal(explorationCalls, 0);
  assert.equal(invalidationReason, "invalid_non_idle_zero_action");
  assert.equal(socket.records.length, 0);
});

test("fallback exploration is allowed only when there are no candidates, parcels, or carried packages", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());

  loop.currentRoutePlan = { mode: "SCOUT", candidateGreens: [] };
  assert.equal(loop.canUseFallbackExploration(loop.currentRoutePlan), true);

  loop.currentRoutePlan = { mode: "SCOUT", candidateGreens: [{ id: "G" }] };
  assert.equal(loop.canUseFallbackExploration(loop.currentRoutePlan), false);

  loop.currentRoutePlan = { mode: "SCOUT", candidateGreens: [] };
  beliefs.parcels.set("P", { id: "P", x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, confidence: 1, lastSeenTime: beliefs.time });
  assert.equal(loop.canUseFallbackExploration(loop.currentRoutePlan), false);

  beliefs.parcels.clear();
  beliefs.carriedParcels.set("C", { id: "C", valueAtPickup: 10 });
  assert.equal(loop.canUseFallbackExploration(loop.currentRoutePlan), false);
});

test("fallback exploration avoids immediate left-right backtrack when an alternative exists", () => {
  const socket = new MockSocket();
  const beliefs = new BeliefState(config());
  const loop = new AgentLoop(socket, beliefs, config());
  beliefs.updateMap(3, 2, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "3" },
    { x: 1, y: 1, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateSelf({ id: "ME", name: "me", x: 1, y: 0, score: 0, penalty: 0 });

  const action = loop.explorationAction();

  assert.notDeepEqual(action.to, { x: 0, y: 0 });
});

test("pickup-only completion triggers delivery-only replan after pickup", async () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: {
      ...config().planner,
      maxPickupsBeforeDelivery: 0
    }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  registerSdkListeners(socket, beliefs, loop);
  emitInitialWorld(socket);

  await loop.tick();
  assert.equal(loop.currentRoutePlan.mode, "PICKUP_ONLY");
  await loop.tick();
  assert.equal(loop.currentRoutePlan, null);
  assert.equal(beliefs.carriedParcels.size, 1);
  await loop.tick();

  assert.equal(loop.currentRoutePlan.mode, "DELIVERY_ONLY");
  assert.ok(loop.currentExecutablePlan.some((action) => action.type === "put_down"));
});

test("opportunistic precheck skips heavy evaluation when no parcel is nearby", async () => {
  const socket = new MockSocket();
  const cfg = config();
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(4, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "3" },
    { x: 3, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.consumeEvents();
  beliefs.clearDirty();
  loop.currentRoutePlan = {
    mode: "DELIVERY_ONLY",
    sequence: ["START", "R"],
    path: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 }
    ],
    config: { periodicReplanTicks: 100 }
  };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { type: "move", direction: "right", from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
  ];
  loop.lastPlanTime = beliefs.time;
  let heavyChecks = 0;
  loop.findOpportunisticPickup = () => {
    heavyChecks += 1;
    return null;
  };

  await loop.tick();

  assert.equal(heavyChecks, 0);
});

test("opportunistic precheck detects parcels near the future path and throttle skips the next tick", () => {
  const socket = new MockSocket();
  const cfg = {
    ...config(),
    planner: {
      ...config().planner,
      opportunisticCheckIntervalTicks: 2,
      opportunisticPathRadius: 1,
      opportunisticMaxDistance: 1
    }
  };
  const beliefs = new BeliefState(cfg);
  const loop = new AgentLoop(socket, beliefs, cfg);
  beliefs.updateMap(4, 2, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "3" },
    { x: 3, y: 0, type: "2" },
    { x: 2, y: 1, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "SIDE", x: 2, y: 1, reward: 20 }], [{ x: 2, y: 1 }]);
  loop.currentRoutePlan = {
    mode: "DELIVERY_ONLY",
    sequence: ["START", "R"],
    path: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 }
    ]
  };
  loop.currentExecutablePlan = [
    { type: "move", direction: "right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { type: "move", direction: "right", from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
  ];
  loop.actionIndex = 0;

  const pathPoints = loop.futurePathPoints();
  assert.equal(loop.hasNearbyOpportunisticParcel(pathPoints), true);
  loop.telemetry.tick = 10;
  loop.lastOpportunisticCheckTick = 10;
  assert.equal(loop.shouldCheckOpportunisticPickup([], pathPoints), false);
  loop.telemetry.tick = 12;
  assert.equal(loop.shouldCheckOpportunisticPickup([], pathPoints), true);
});
