import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CONFIG } from "../src/config.js";
import { isWalkable } from "../src/planner/route-planner.js";
import { BeliefState } from "../src/state/belief-state.js";
import { buildPlannerState } from "../src/state/planner-state.js";
import { registerSdkListeners } from "../src/state/sdk-adapter.js";

function testConfig() {
  return {
    ...CONFIG,
    planner: {
      ...CONFIG.planner,
      decayRate: 1,
      minParcelConfidence: 0.3,
      beliefDecayRate: 0.1
    }
  };
}

function setupBeliefs() {
  const beliefs = new BeliefState(testConfig());
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  return beliefs;
}

test("parcel seen has confidence 1", () => {
  const beliefs = setupBeliefs();
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);
  assert.equal(beliefs.parcels.get("P").confidence, 1);
});

test("parcel outside sensing range decays slowly instead of being removed", () => {
  const beliefs = setupBeliefs();
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);
  beliefs.advanceTime();
  beliefs.updateParcelsSensing([], [{ x: 0, y: 0 }]);
  const parcel = beliefs.parcels.get("P");
  assert.ok(parcel);
  assert.ok(parcel.confidence < 1);
  assert.ok(parcel.confidence > 0.3);
});

test("parcel absent inside sensing range is invalidated", () => {
  const beliefs = setupBeliefs();
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);
  beliefs.advanceTime();
  beliefs.updateParcelsSensing([], [{ x: 1, y: 0 }]);
  assert.equal(beliefs.parcels.get("P").confidence, 0);
});

test("parcel absent inside inferred visible range is invalidated", () => {
  const beliefs = setupBeliefs();
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }]);
  beliefs.advanceTime();
  beliefs.updateParcelsSensing([]);

  assert.equal(beliefs.parcels.get("P").confidence, 0);
  assert.ok(beliefs.events.some((event) => event.type === "BELIEF_INVALIDATED"));
});

test("parcel absent outside inferred visible range decays slowly", () => {
  const config = {
    ...testConfig(),
    planner: {
      ...testConfig().planner,
      sensingRange: 1
    }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(8, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 6, y: 0, type: "1" },
    { x: 7, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 6, y: 0, reward: 20 }]);
  beliefs.advanceTime();
  beliefs.updateParcelsSensing([]);

  const parcel = beliefs.parcels.get("P");
  assert.ok(parcel.confidence > 0);
  assert.ok(parcel.confidence < 1);
});

test("server reward is not decayed twice", () => {
  const beliefs = setupBeliefs();
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 50 }], [{ x: 1, y: 0 }]);
  beliefs.advanceTime();
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 49 }], [{ x: 1, y: 0 }]);
  assert.equal(beliefs.estimateParcelReward(beliefs.parcels.get("P")), 49);
  beliefs.advanceTime();
  assert.equal(beliefs.estimateParcelReward(beliefs.parcels.get("P")), 48);
});

test("carriedBy excludes parcel from planner targets", () => {
  const config = testConfig();
  const beliefs = setupBeliefs();
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20, carriedBy: "E" }], [{ x: 1, y: 0 }]);
  const plannerState = buildPlannerState(beliefs, config);
  assert.equal(plannerState.greens[0].package, null);
});

test("planner state normalizes tile 0 as non-walkable", () => {
  const config = testConfig();
  const beliefs = new BeliefState(config);
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "0" },
    { x: 1, y: 0, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 1, y: 0, score: 0, penalty: 0 });
  const plannerState = buildPlannerState(beliefs, config);

  assert.equal(isWalkable(plannerState, { x: 0, y: 0 }), false);
  assert.equal(isWalkable(plannerState, { x: 1, y: 0 }), true);
});

test("map and planner state infer dimensions from tiles", () => {
  const config = testConfig();
  const beliefs = new BeliefState(config);
  beliefs.updateMap(0, 0, [
    { x: 0, y: 0, type: "3" },
    { x: 4, y: 2, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  const plannerState = buildPlannerState(beliefs, config);

  assert.equal(beliefs.width, 5);
  assert.equal(beliefs.height, 3);
  assert.equal(plannerState.width, 5);
  assert.equal(plannerState.height, 3);
  assert.equal(plannerState.grid[2][4].type, "red");

  const tooSmall = new BeliefState(config);
  tooSmall.updateMap(1, 1, [{ x: 3, y: 2, type: "1" }]);
  tooSmall.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  const tooSmallPlannerState = buildPlannerState(tooSmall, config);

  assert.equal(tooSmallPlannerState.width, 4);
  assert.equal(tooSmallPlannerState.height, 3);
});

test("tile boolean SDK event maps true to red and false to walkable", () => {
  const socket = new EventEmitter();
  const beliefs = new BeliefState(testConfig());
  registerSdkListeners(socket, beliefs);

  socket.emit("tile", 0, 0, true);
  socket.emit("tile", 1, 0, false);

  assert.equal(beliefs.tiles.get("0,0").type, "2");
  assert.equal(beliefs.tiles.get("1,0").type, "3");
});

test("visible parcel on walkable tile becomes a pseudo-green", () => {
  const config = testConfig();
  const beliefs = new BeliefState(config);
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);

  const plannerState = buildPlannerState(beliefs, config);
  const pseudoGreen = plannerState.greens.find((green) => green.id === "P_P");

  assert.ok(pseudoGreen);
  assert.equal(pseudoGreen.package.id, "P");
});

test("visible parcel on wall tile does not become a pseudo-green", () => {
  const config = testConfig();
  const beliefs = new BeliefState(config);
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "0" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);

  const plannerState = buildPlannerState(beliefs, config);

  assert.equal(plannerState.greens.some((green) => green.id === "P_P"), false);
});

test("parcel beliefs contribute greensWithPackage in planner state", () => {
  const config = testConfig();
  const beliefs = new BeliefState(config);
  beliefs.updateMap(4, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "1" },
    { x: 3, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);

  const plannerState = buildPlannerState(beliefs, config);

  assert.ok(beliefs.parcels.size > 0);
  assert.ok(plannerState.greens.filter((green) => green.package).length > 0);
});

test("SDK-style belief updates mark version but do not advance game time without server time", () => {
  const beliefs = setupBeliefs();
  const initialTime = beliefs.time;
  const initialVersion = beliefs.version;

  beliefs.updateSelf({ id: "ME", name: "me", x: 1, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 20 }], [{ x: 1, y: 0 }]);

  assert.equal(beliefs.time, initialTime);
  assert.ok(beliefs.version > initialVersion);

  beliefs.advanceTime();
  assert.equal(beliefs.time, initialTime + 1);
});
