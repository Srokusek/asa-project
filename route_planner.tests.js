import assert from "node:assert/strict";
import {
  buildMapProfile,
  chooseConfig,
  parseMap,
  replan,
  resetPlannerMemory,
  shouldRecompute
} from "./route_planner.js";

function normalGrid(width, height) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => "normal"));
}

function pkg(id, value, decayRate = 0) {
  return { id, value, spawnTime: 0, decayRate };
}

function run(name, fn) {
  try {
    resetPlannerMemory();
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function abcLowExtraCostState(overrides = {}) {
  return parseMap({
    width: 10,
    height: 10,
    time: 0,
    grid: [
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"],
      ["green", "normal", "green", "green", "red", "normal", "normal", "normal", "normal", "normal"],
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"],
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"],
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"],
      ["normal", "normal", "wall", "wall", "wall", "wall", "wall", "wall", "normal", "normal"],
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"],
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"],
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "green", "red"],
      ["normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"]
    ],
    me: { id: "ME", position: { x: 1, y: 1 } },
    enemies: overrides.enemies ?? [],
    greens: [
      { id: "A", position: { x: 0, y: 1 }, package: pkg("pkg_A", 100) },
      { id: "B", position: { x: 2, y: 1 }, package: pkg("pkg_B", 60) },
      { id: "C", position: { x: 3, y: 1 }, package: pkg("pkg_C", 70) },
      { id: "D", position: { x: 8, y: 8 }, package: pkg("pkg_D", 40) }
    ],
    reds: [
      { id: "R_MAIN", position: { x: 4, y: 1 } },
      { id: "R_SIDE", position: { x: 9, y: 8 } }
    ],
    params: {
      meanPackageValue: 65,
      decayRate: 0,
      generationMeanTime: 10,
      kSmoothMax: 0.25,
      kWin: 1,
      rhoGeneration: 0,
      moveWeight: 25,
      betaCarry: 1,
      periodicReplanTicks: 5,
      maxPickupsBeforeDelivery: 2,
      ...overrides.params
    }
  });
}

run("A=100 loses to B=60 + C=70 when extra route cost is low", () => {
  const result = replan(abcLowExtraCostState());
  assert.deepEqual(result.sequence, ["START", "B", "C", "R_MAIN"]);
});

run("high decay can make nearby A beat slower B + C", () => {
  const grid = normalGrid(10, 3);
  grid[0][1] = "green";
  grid[0][6] = "green";
  grid[0][7] = "green";
  grid[1][0] = "red";

  const result = replan(
    parseMap({
      width: 10,
      height: 3,
      time: 0,
      grid,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "A", position: { x: 1, y: 0 }, package: pkg("pkg_A", 100, 5) },
        { id: "B", position: { x: 6, y: 0 }, package: pkg("pkg_B", 60, 5) },
        { id: "C", position: { x: 7, y: 0 }, package: pkg("pkg_C", 70, 5) }
      ],
      reds: [{ id: "R", position: { x: 0, y: 1 } }],
      params: {
        meanPackageValue: 65,
        decayRate: 5,
        moveWeight: 1,
        betaCarry: 1,
        periodicReplanTicks: 6,
        maxPickupsBeforeDelivery: 2
      }
    })
  );

  assert.deepEqual(result.sequence, ["START", "A", "R"]);
  assert.equal(result.config.periodicReplanTicks, 3);
  assert.equal(
    shouldRecompute(
      { ...parseMap({ width: 2, height: 2, grid: normalGrid(2, 2), params: { decayRate: 1 } }), time: 3 },
      [],
      { path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], pathIndex: 0, generatedAtTime: 0, config: result.config }
    ),
    true
  );
});

run("enemy arriving first on C prevents choosing B + C", () => {
  const result = replan(
    abcLowExtraCostState({
      enemies: [{ id: "E1", position: { x: 3, y: 1 }, speed: 1 }]
    })
  );

  assert.equal(result.sequence.includes("C"), false);
});

run("with two reds the solver chooses the best net delivery point", () => {
  const grid = normalGrid(5, 3);
  grid[0][1] = "green";
  grid[0][4] = "red";
  grid[1][1] = "red";

  const result = replan(
    parseMap({
      width: 5,
      height: 3,
      grid,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [{ id: "P", position: { x: 1, y: 0 }, package: pkg("pkg_P", 50) }],
      reds: [
        { id: "R_FAR", position: { x: 4, y: 0 } },
        { id: "R_NEAR", position: { x: 1, y: 1 } }
      ],
      params: {
        meanPackageValue: 50,
        decayRate: 0,
        moveWeight: 2,
        betaCarry: 1,
        maxPickupsBeforeDelivery: 1
      }
    })
  );

  assert.deepEqual(result.sequence, ["START", "P", "R_NEAR"]);
});

run("100 green map uses dense topK and beam limits", () => {
  const width = 20;
  const height = 6;
  const greens = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < width; x += 1) {
      greens.push({ id: `G_${x}_${y}`, position: { x, y }, package: null });
    }
  }

  const state = parseMap({
    width,
    height,
    grid: normalGrid(width, height),
    me: { id: "ME", position: { x: 0, y: 5 } },
    greens,
    reds: [{ id: "R", position: { x: 19, y: 5 } }],
    params: { meanPackageValue: 10, generationMeanTime: 10 }
  });
  const profile = buildMapProfile(state);
  const config = chooseConfig(profile, state.params);
  const result = replan(state);

  assert.equal(profile.greenCount, 100);
  assert.equal(config.mode, "DENSE_BEAM");
  assert.equal(config.topK, 8);
  assert.equal(config.beamWidth, 20);
  assert.equal(config.maxPickupsBeforeDelivery, 3);
  assert.equal(result.candidateGreens.length, 8);
});
