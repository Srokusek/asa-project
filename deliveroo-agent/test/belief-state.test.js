import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../src/config.js";
import { isWalkable } from "../src/planner/route-planner.js";
import { BeliefState } from "../src/state/belief-state.js";
import { buildPlannerState } from "../src/state/planner-state.js";

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
