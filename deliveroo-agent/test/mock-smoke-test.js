import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CONFIG } from "../src/config.js";
import { AgentLoop } from "../src/control/agent-loop.js";
import { BeliefState } from "../src/state/belief-state.js";
import { registerSdkListeners } from "../src/state/sdk-adapter.js";

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.position = { x: 0, y: 0 };
    this.carried = [];
    this.records = [];
    this.failNextMove = false;
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
    if (this.position.x === 1 && this.position.y === 0) {
      this.carried = [{ id: "P" }];
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
