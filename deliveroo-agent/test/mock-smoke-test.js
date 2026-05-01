import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CONFIG } from "../src/config.js";
import { AgentLoop } from "../src/control/agent-loop.js";
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
    this.failNextPickup = false;
    this.pickupReward = null;
  }

  async emitMove(direction) {
    this.records.push({ type: "move", direction });
    if (this.failNextMove) {
      this.failNextMove = false;
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

  await loop.tick();
  assert.equal(socket.records.filter((record) => record.type === "move").length, 2);
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
