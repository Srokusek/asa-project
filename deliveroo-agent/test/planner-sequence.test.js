import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMapProfile,
  chooseConfig,
  parseMap,
  replan
} from "../src/planner/route-planner.js";

function grid(width, height, fill = "3") {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
}

function pkg(id, value, confidence = 1, decayRate = 0) {
  return { id, value, reward: value, confidence, spawnTime: 0, decayRate };
}

function abcState(overrides = {}) {
  const map = grid(6, 2);
  map[0][0] = "1";
  map[0][2] = "1";
  map[0][3] = "1";
  map[0][4] = "2";

  return parseMap({
    width: 6,
    height: 2,
    time: 0,
    grid: map,
    me: { id: "ME", position: { x: 1, y: 0 } },
    enemies: overrides.enemies ?? [],
    greens: [
      { id: "A", position: { x: 0, y: 0 }, package: pkg("pkg_A", 100, 1, overrides.decayRate ?? 0) },
      { id: "B", position: { x: 2, y: 0 }, package: pkg("pkg_B", 60, 1, overrides.decayRate ?? 0) },
      { id: "C", position: { x: 3, y: 0 }, package: pkg("pkg_C", 70, 1, overrides.decayRate ?? 0) }
    ],
    reds: [{ id: "RED", position: { x: 4, y: 0 } }],
    params: {
      meanPackageValue: 10,
      decayRate: overrides.decayRate ?? 0,
      moveWeight: overrides.moveWeight ?? 25,
      betaCarry: 1,
      maxPickupsBeforeDelivery: 2,
      minParcelConfidence: 0.3,
      ...overrides.params
    }
  });
}

test("A=100 loses to B=60 + C=70 when net value is better", () => {
  const plan = replan(abcState());
  assert.deepEqual(plan.sequence, ["START", "B", "C", "RED"]);
});

test("high decay can make nearby A beat slower B + C", () => {
  const map = grid(10, 3);
  map[0][1] = "1";
  map[0][6] = "1";
  map[0][7] = "1";
  map[1][1] = "2";

  const plan = replan(
    parseMap({
      width: 10,
      height: 3,
      time: 0,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "A", position: { x: 1, y: 0 }, package: pkg("pkg_A", 100, 1, 5) },
        { id: "B", position: { x: 6, y: 0 }, package: pkg("pkg_B", 60, 1, 5) },
        { id: "C", position: { x: 7, y: 0 }, package: pkg("pkg_C", 70, 1, 5) }
      ],
      reds: [{ id: "RED", position: { x: 1, y: 1 } }],
      params: {
        meanPackageValue: 10,
        decayRate: 5,
        moveWeight: 1,
        betaCarry: 1,
        maxPickupsBeforeDelivery: 2
      }
    })
  );

  assert.deepEqual(plan.sequence, ["START", "A", "RED"]);
});

test("enemy arriving first on C prevents choosing B + C", () => {
  const plan = replan(
    abcState({
      enemies: [{ id: "E", position: { x: 3, y: 0 }, speed: 1 }]
    })
  );
  assert.equal(plan.sequence.includes("C"), false);
});

test("green without package does not enter pickup candidates even with future score", () => {
  const map = grid(5, 1);
  map[0][1] = "1";
  map[0][2] = "1";
  map[0][4] = "2";
  const plan = replan(
    parseMap({
      width: 5,
      height: 1,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "EMPTY", position: { x: 1, y: 0 }, package: null },
        { id: "FULL", position: { x: 2, y: 0 }, package: pkg("pkg_full", 20) }
      ],
      reds: [{ id: "RED", position: { x: 4, y: 0 } }],
      params: {
        meanPackageValue: 1000,
        generationProbability: 1,
        rhoGeneration: 0,
        maxPickupsBeforeDelivery: 2
      }
    })
  );

  assert.equal(plan.candidateGreens.some((green) => green.id === "EMPTY"), false);
  assert.equal(plan.sequence.includes("EMPTY"), false);
});

test("100 green and 10 red map uses topK and beamWidth", () => {
  const width = 20;
  const height = 6;
  const map = grid(width, height);
  const greens = [];
  const reds = [];

  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < width; x += 1) {
      map[y][x] = "1";
      greens.push({ id: `G_${x}_${y}`, position: { x, y }, package: pkg(`P_${x}_${y}`, 10) });
    }
  }
  for (let x = 0; x < 10; x += 1) {
    map[5][x] = "2";
    reds.push({ id: `R_${x}`, position: { x, y: 5 } });
  }

  const state = parseMap({
    width,
    height,
    grid: map,
    me: { id: "ME", position: { x: 19, y: 5 } },
    greens,
    reds,
    params: { meanPackageValue: 10 }
  });
  const profile = buildMapProfile(state);
  const config = chooseConfig(profile, state.params);
  const plan = replan(state);

  assert.equal(profile.greenCount, 100);
  assert.equal(config.mode, "DENSE_BEAM");
  assert.equal(config.topK, 8);
  assert.equal(config.beamWidth, 20);
  assert.equal(plan.candidateGreens.length, 8);
});
