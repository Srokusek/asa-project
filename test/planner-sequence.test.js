import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CONFIG } from "../src/config.js";
import { buildExecutablePlan } from "../src/planner/executable-plan.js";
import {
  buildDistanceOracle,
  buildMapProfile,
  buildPointsOfInterest,
  chooseConfig,
  futureGreenValue,
  informationValueAtWaypoint,
  initialPlan,
  isMoveAllowed,
  isWalkable,
  planValue,
  parseMap,
  replan,
  shortestGridPath
} from "../src/planner/route-planner.js";
import { BeliefState } from "../src/state/belief-state.js";
import { buildPlannerState } from "../src/state/planner-state.js";

function grid(width, height, fill = "3") {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
}

function pkg(id, value, confidence = 1, decayRate = 0) {
  return { id, value, reward: value, confidence, spawnTime: 0, decayRate };
}

function routePlanToSinglePoint(point) {
  const start = { id: "START", type: "start", position: { x: 0, y: 0 } };
  return {
    sequence: ["START", point.id],
    path: [start.position, point.position],
    oracle: {
      entries: new Map([
        [
          `START->${point.id}`,
          {
            fromId: "START",
            toId: point.id,
            cost: 1,
            path: [start.position, point.position]
          }
        ]
      ]),
      points: [start, point],
      pointsById: new Map([
        ["START", start],
        [point.id, point]
      ])
    }
  };
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

test("multiple adjacent packages are collected before delivery when net value is better", () => {
  const map = grid(7, 3);
  map[1][1] = "1";
  map[1][2] = "1";
  map[1][3] = "1";
  map[1][6] = "2";

  const plan = replan(
    parseMap({
      width: 7,
      height: 3,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 1 } },
      greens: [
        { id: "P1", position: { x: 1, y: 1 }, package: pkg("p1", 30) },
        { id: "P2", position: { x: 2, y: 1 }, package: pkg("p2", 30) },
        { id: "P3", position: { x: 3, y: 1 }, package: pkg("p3", 30) }
      ],
      reds: [{ id: "R", position: { x: 6, y: 1 } }],
      params: {
        decayRate: 0,
        moveWeight: 1,
        betaCarry: 1,
        maxPickupsBeforeDelivery: 3,
        clusterPickupRadius: 3
      }
    })
  );

  assert.deepEqual(plan.sequence, ["START", "P1", "P2", "P3", "R"]);
});

test("adjacent package cluster can be skipped under high decay", () => {
  const map = grid(7, 3);
  map[1][1] = "1";
  map[1][2] = "1";
  map[1][3] = "1";
  map[1][6] = "2";

  const plan = replan(
    parseMap({
      width: 7,
      height: 3,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 1 } },
      greens: [
        { id: "P1", position: { x: 1, y: 1 }, package: pkg("p1", 30, 1, 10) },
        { id: "P2", position: { x: 2, y: 1 }, package: pkg("p2", 30, 1, 10) },
        { id: "P3", position: { x: 3, y: 1 }, package: pkg("p3", 30, 1, 10) }
      ],
      reds: [{ id: "R", position: { x: 6, y: 1 } }],
      params: {
        decayRate: 10,
        moveWeight: 1,
        betaCarry: 1,
        maxPickupsBeforeDelivery: 3,
        clusterPickupRadius: 3
      }
    })
  );

  assert.deepEqual(plan.sequence, ["START", "P1", "R"]);
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

test("future green value is zero when maxPackages is already reached", () => {
  const map = grid(5, 1);
  map[0][1] = "1";
  map[0][2] = "1";
  map[0][4] = "2";
  const state = parseMap({
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
      meanPackageValue: 100,
      generationProbability: 1,
      maxPackages: 1
    }
  });
  const config = chooseConfig(buildMapProfile(state), state.params);

  assert.equal(futureGreenValue(state, state.greens.find((green) => green.id === "EMPTY"), config), 0);
});

test("pseudo-green with a visible parcel on walkable tile produces candidates", () => {
  const config = {
    ...CONFIG,
    planner: {
      ...CONFIG.planner,
      decayRate: 0,
      moveWeight: 1,
      betaCarry: 1,
      minParcelConfidence: 0.3
    }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(4, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "3" },
    { x: 3, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 25 }], [{ x: 1, y: 0 }]);

  const plan = replan(buildPlannerState(beliefs, config));

  assert.ok(plan.candidateGreens.length > 0);
  assert.ok(plan.sequence.length > 1);
});

test("no visible parcels with known greens produces a scout move without pickup", () => {
  const map = grid(4, 1);
  map[0][2] = "1";
  map[0][3] = "2";
  const plan = replan(
    parseMap({
      width: 4,
      height: 1,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
    })
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "SCOUT");
  assert.equal(plan.sequence[0], "START");
  assert.match(plan.sequence[1], /^SCOUT_/);
  assert.ok(actions.some((action) => action.type === "move"));
  assert.equal(actions.some((action) => action.type === "pick_up"), false);
});

test("information-aware scout prefers a stale green over a recently observed nearby green", () => {
  const map = grid(6, 1);
  map[0][1] = "1";
  map[0][4] = "1";
  map[0][5] = "2";

  const plan = replan(
    parseMap({
      width: 6,
      height: 1,
      time: 10,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "G1", position: { x: 1, y: 0 }, package: null },
        { id: "G2", position: { x: 4, y: 0 }, package: null }
      ],
      reds: [{ id: "R", position: { x: 5, y: 0 } }],
      lastObservedAtByTile: { "0,0": 10, "1,0": 10, "2,0": 10 },
      lastObservedAtByGreen: { "1,0": 10 },
      params: {
        decayRate: 0,
        sensingRange: 1,
        infoValueWeight: 1,
        scoutDistanceWeight: 1,
        noveltyBonus: 0,
        sameScoutTargetPenalty: 0,
        recentScoutPenalty: 0
      }
    })
  );

  assert.equal(plan.mode, "SCOUT");
  assert.equal(plan.scoutTarget.id, "G2");
  assert.ok(plan.scoutTarget.infoValue > 0);
});

test("scout vision footprint can beat a nearer low-information green", () => {
  const map = grid(8, 3);
  map[1][1] = "1";
  map[1][5] = "1";
  map[0][4] = "1";
  map[0][5] = "1";
  map[0][6] = "1";
  map[2][5] = "1";
  map[2][6] = "1";
  map[1][7] = "2";

  const state = parseMap({
    width: 8,
    height: 3,
    time: 10,
    grid: map,
    me: { id: "ME", position: { x: 0, y: 1 } },
    greens: [
      { id: "NEAR", position: { x: 1, y: 1 }, package: null },
      { id: "HUB", position: { x: 5, y: 1 }, package: null },
      { id: "H1", position: { x: 4, y: 0 }, package: null },
      { id: "H2", position: { x: 5, y: 0 }, package: null },
      { id: "H3", position: { x: 6, y: 0 }, package: null },
      { id: "H4", position: { x: 5, y: 2 }, package: null },
      { id: "H5", position: { x: 6, y: 2 }, package: null }
    ],
    reds: [{ id: "R", position: { x: 7, y: 1 } }],
    lastObservedAtByTile: { "0,1": 10, "1,1": 10, "2,1": 10 },
    lastObservedAtByGreen: { "1,1": 10 },
    params: {
      decayRate: 0,
      sensingRange: 2,
      infoValueWeight: 1,
      scoutDistanceWeight: 1,
      noveltyBonus: 0,
      sameScoutTargetPenalty: 0,
      recentScoutPenalty: 0
    }
  });
  const config = chooseConfig(buildMapProfile(state), state.params);
  const nearInfo = informationValueAtWaypoint(state, { x: 1, y: 1 }, config);
  const hubInfo = informationValueAtWaypoint(state, { x: 5, y: 1 }, config);
  const plan = replan(state);

  assert.ok(hubInfo > nearInfo);
  assert.equal(plan.mode, "SCOUT");
  assert.ok(plan.scoutTarget.greenIds.includes("HUB"));
});

test("empty green future value disabled still allows scout through information value", () => {
  const map = grid(4, 1);
  map[0][2] = "1";
  const plan = replan(
    parseMap({
      width: 4,
      height: 1,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [{ id: "EMPTY", position: { x: 2, y: 0 }, package: null }],
      params: {
        decayRate: 0,
        emptyGreenFutureWeight: 0,
        meanPackageValue: 1000,
        generationProbability: 1
      }
    })
  );

  assert.equal(plan.mode, "SCOUT");
  assert.equal(plan.scoutTarget.id, "EMPTY");
  assert.equal(plan.candidateGreens.length, 0);
  assert.ok(plan.scoutTarget.infoValue > 0);
});

test("exploration debt lets a stale far cluster beat a fresh nearby cluster", () => {
  const map = grid(10, 1);
  map[0][1] = "1";
  map[0][8] = "1";
  map[0][9] = "2";

  const plan = replan(
    parseMap({
      width: 10,
      height: 1,
      time: 40,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "NEAR", position: { x: 1, y: 0 }, package: null },
        { id: "FAR", position: { x: 8, y: 0 }, package: null }
      ],
      reds: [{ id: "R", position: { x: 9, y: 0 } }],
      lastObservedAtByTile: {
        "0,0": 40,
        "1,0": 40,
        "2,0": 40,
        "8,0": 0
      },
      lastObservedAtByGreen: {
        "1,0": 40,
        "8,0": 0
      },
      params: {
        decayRate: 0,
        sensingRange: 1,
        greenClusterDistance: 1,
        infoValueWeight: 0.2,
        scoutDistanceWeight: 1,
        noveltyBonus: 0,
        sameScoutTargetPenalty: 0,
        recentScoutPenalty: 10,
        explorationDebtThreshold: 25,
        explorationDebtBonus: 40
      }
    })
  );

  assert.equal(plan.mode, "SCOUT");
  assert.equal(plan.scoutTarget.id, "FAR");
  assert.ok(plan.scoutTarget.debtBonus > 0);
});

test("replan avoids a temporarily blocked cell on the direct path", () => {
  const config = {
    ...CONFIG,
    planner: {
      ...CONFIG.planner,
      decayRate: 0,
      moveWeight: 1,
      betaCarry: 1
    }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(3, 3, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "3" },
    { x: 0, y: 1, type: "3" },
    { x: 1, y: 1, type: "3" },
    { x: 2, y: 1, type: "3" },
    { x: 0, y: 2, type: "3" },
    { x: 1, y: 2, type: "3" },
    { x: 2, y: 2, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 1, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 2, y: 1, reward: 30 }], [{ x: 2, y: 1 }]);
  beliefs.markTemporaryBlocked({ x: 1, y: 1 }, 3, "test");

  const plan = replan(buildPlannerState(beliefs, config));

  assert.equal(plan.path.some((position) => position.x === 1 && position.y === 1), false);
  assert.ok(plan.path.some((position) => position.y !== 1));
});

test("scout avoids a recently visited nearby green", () => {
  const map = grid(5, 1);
  map[0][1] = "1";
  map[0][3] = "1";
  map[0][4] = "2";
  const plan = replan(
    parseMap({
      width: 5,
      height: 1,
      time: 10,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "G1", position: { x: 1, y: 0 }, package: null },
        { id: "G2", position: { x: 3, y: 0 }, package: null }
      ],
      reds: [{ id: "R", position: { x: 4, y: 0 } }],
      visitedGreenAt: { G1: 9 },
      lastScoutTargetId: "G1",
      params: {
        decayRate: 0,
        scoutCooldownTicks: 8,
        recentScoutPenalty: 15,
        sameScoutTargetPenalty: 20,
        greenClusterDistance: 1
      }
    })
  );

  assert.equal(plan.mode, "SCOUT");
  assert.equal(plan.scoutTarget.id, "G2");
});

test("no parcels and no known greens explores an adjacent walkable tile", () => {
  const plan = replan(
    parseMap({
      width: 2,
      height: 1,
      grid: [["3", "3"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      params: { decayRate: 0 }
    })
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "LOCAL_EXPLORE");
  assert.deepEqual(plan.sequence, ["START", "EXPLORE"]);
  assert.deepEqual(actions.map((action) => action.type), ["move"]);
});

test("no parcels, no greens, and no adjacent walkable tiles returns idle", () => {
  const map = grid(3, 3, "0");
  map[1][1] = "3";
  const plan = replan(
    parseMap({
      width: 3,
      height: 3,
      grid: map,
      me: { id: "ME", position: { x: 1, y: 1 } },
      params: { decayRate: 0 }
    })
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "IDLE");
  assert.deepEqual(plan.sequence, ["START"]);
  assert.equal(actions.length, 0);
});

test("visible parcel uses pickup delivery mode with explicit pickup and putdown", () => {
  const config = {
    ...CONFIG,
    planner: {
      ...CONFIG.planner,
      decayRate: 0,
      moveWeight: 1,
      betaCarry: 1,
      minParcelConfidence: 0.3
    }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(4, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "3" },
    { x: 3, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 25 }], [{ x: 1, y: 0 }]);

  const plan = replan(buildPlannerState(beliefs, config));
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "PICKUP_DELIVERY");
  assert.ok(plan.sequence.some((id) => id === "P_P" || id.startsWith("G_")));
  assert.ok(actions.some((action) => action.type === "pick_up"));
  assert.ok(actions.some((action) => action.type === "put_down"));
});

test("carried parcel without visible parcels produces delivery only mode", () => {
  const plan = replan(
    parseMap({
      width: 3,
      height: 1,
      grid: [["3", "3", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      carriedPackages: [
        {
          packageId: "CARRIED",
          valueAtPickup: 20,
          pickupTime: 0,
          decayRate: 0,
          confidence: 1
        }
      ],
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
    })
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "DELIVERY_ONLY");
  assert.deepEqual(plan.sequence, ["START", "R_2_0"]);
  assert.ok(actions.some((action) => action.type === "put_down"));
});

test("executable plan does not pick up scout targets", () => {
  const routePlan = routePlanToSinglePoint({
    id: "SCOUT_G_1_0",
    type: "scout",
    position: { x: 1, y: 0 },
    noPickup: true
  });
  const actions = buildExecutablePlan(routePlan);

  assert.deepEqual(actions.map((action) => action.type), ["move"]);
});

test("executable plan does not pick up green targets without package", () => {
  const routePlan = routePlanToSinglePoint({
    id: "G_1_0",
    type: "green",
    position: { x: 1, y: 0 },
    package: null
  });
  const actions = buildExecutablePlan(routePlan);

  assert.deepEqual(actions.map((action) => action.type), ["move"]);
});

test("executable plan picks up green targets with package", () => {
  const routePlan = routePlanToSinglePoint({
    id: "G_1_0",
    type: "green",
    position: { x: 1, y: 0 },
    package: pkg("P", 10)
  });
  const actions = buildExecutablePlan(routePlan);

  assert.deepEqual(actions.map((action) => action.type), ["move", "pick_up"]);
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

test("paths never cross non-walkable tiles and use BFS cost when obstacles exist", () => {
  const map = grid(5, 3);
  map[1][1] = "0";
  map[1][2] = "1";
  map[1][4] = "2";
  const state = parseMap({
    width: 5,
    height: 3,
    grid: map,
    me: { id: "ME", position: { x: 0, y: 1 } },
    greens: [{ id: "G", position: { x: 2, y: 1 }, package: pkg("P", 30) }],
    reds: [{ id: "R", position: { x: 4, y: 1 } }],
    params: { moveWeight: 1, betaCarry: 1, decayRate: 0 }
  });

  const startToGreen = shortestGridPath(state, { x: 0, y: 1 }, { x: 2, y: 1 });
  const plan = replan(state);

  assert.equal(startToGreen.cost, 4);
  assert.equal(plan.profile.hasObstacles, true);
  assert.equal(plan.path.some((p) => p.x === 1 && p.y === 1), false);
  assert.deepEqual(plan.sequence, ["START", "G", "R"]);
});

test("shortestGridPath rejects stale Manhattan paths that would cross walls", () => {
  const map = grid(5, 3);
  map[1][1] = "0";
  const state = parseMap({
    width: 5,
    height: 3,
    grid: map,
    me: { id: "ME", position: { x: 0, y: 1 } }
  });
  const staleProfile = { hasObstacles: false, hasUniformCosts: true };

  const path = shortestGridPath(state, { x: 0, y: 1 }, { x: 2, y: 1 }, staleProfile);

  assert.equal(path.cost, 4);
  assert.equal(path.path.some((position) => position.x === 1 && position.y === 1), false);
  assert.ok(path.path.every((position) => isWalkable(state, position)));
});

test("arrow tiles restrict outgoing movement direction", () => {
  const state = parseMap({
    width: 3,
    height: 3,
    grid: [
      ["0", "0", "0"],
      ["0", "arrow_up", "3"],
      ["0", "3", "0"]
    ],
    me: { id: "ME", position: { x: 1, y: 1 } }
  });

  assert.equal(isMoveAllowed(state, { x: 1, y: 1 }, { x: 1, y: 2 }), true);
  assert.equal(isMoveAllowed(state, { x: 1, y: 1 }, { x: 2, y: 1 }), false);

  const forbiddenPath = shortestGridPath(state, { x: 1, y: 1 }, { x: 2, y: 1 });
  assert.equal(forbiddenPath.cost, Infinity);
});

test("distance oracle uses single-source BFS on hallway-like uniform maps", () => {
  const width = 40;
  const height = 7;
  const map = grid(width, height, "0");
  const greens = [];
  const reds = [];

  for (let x = 0; x < width; x += 1) {
    map[3][x] = "3";
  }
  for (let x = 4; x < width; x += 7) {
    map[2][x] = "3";
    map[1][x] = "1";
    greens.push({ id: `G${x}`, position: { x, y: 1 }, package: pkg(`P${x}`, 10) });
  }
  for (let x = 6; x < width; x += 11) {
    map[4][x] = "3";
    map[5][x] = "2";
    reds.push({ id: `R${x}`, position: { x, y: 5 } });
  }

  const state = parseMap({
    width,
    height,
    grid: map,
    me: { id: "ME", position: { x: 0, y: 3 } },
    greens,
    reds,
    params: { decayRate: 0, topK: greens.length, beamWidth: 30 }
  });
  const points = buildPointsOfInterest(state, greens);
  const start = performance.now();
  const oracle = buildDistanceOracle(state, points);
  const elapsed = performance.now() - start;

  assert.equal(oracle.stats.singleSourceBfsRuns, points.length);
  assert.equal(oracle.stats.pathfindingCalls, 0);
  assert.ok(elapsed < 80, `oracle took ${elapsed}ms`);
});

test("when already carrying parcels, direct delivery can beat another pickup", () => {
  const map = grid(4, 1);
  map[0][1] = "2";
  map[0][3] = "1";
  const plan = replan(
    parseMap({
      width: 4,
      height: 1,
      grid: map,
      time: 10,
      me: { id: "ME", position: { x: 0, y: 0 } },
      carriedPackages: [
        {
          packageId: "CARRIED_1",
          valueAtPickup: 100,
          pickupTime: 10,
          decayRate: 0,
          confidence: 1
        }
      ],
      greens: [{ id: "LOW_VALUE", position: { x: 3, y: 0 }, package: pkg("LOW", 1) }],
      reds: [{ id: "R", position: { x: 1, y: 0 } }],
      params: {
        moveWeight: 1,
        betaCarry: 1,
        decayRate: 0,
        maxPickupsBeforeDelivery: 2
      }
    })
  );

  assert.deepEqual(plan.sequence, ["START", "R"]);
});

test("carried packages count against max pickups before delivery", () => {
  const map = grid(4, 1);
  map[0][1] = "1";
  map[0][2] = "1";
  map[0][3] = "2";
  const plan = replan(
    parseMap({
      width: 4,
      height: 1,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      carriedPackages: [
        {
          packageId: "CARRIED_1",
          valueAtPickup: 30,
          pickupTime: 0,
          decayRate: 0,
          confidence: 1
        }
      ],
      greens: [
        { id: "G1", position: { x: 1, y: 0 }, package: pkg("P1", 100) },
        { id: "G2", position: { x: 2, y: 0 }, package: pkg("P2", 100) }
      ],
      reds: [{ id: "R", position: { x: 3, y: 0 } }],
      params: {
        moveWeight: 0,
        betaCarry: 1,
        decayRate: 0,
        maxPickupsBeforeDelivery: 1
      }
    })
  );

  assert.deepEqual(plan.sequence, ["START", "R"]);
});

test("carried potential subtracts future delivery movement cost", () => {
  const map = grid(6, 1);
  map[0][5] = "2";
  const state = parseMap({
    width: 6,
    height: 1,
    grid: map,
    me: { id: "ME", position: { x: 0, y: 0 } },
    carriedPackages: [
      {
        packageId: "CARRIED_1",
        valueAtPickup: 10,
        pickupTime: 0,
        decayRate: 0,
        confidence: 1
      }
    ],
    reds: [{ id: "R", position: { x: 5, y: 0 } }],
    params: { moveWeight: 3, betaCarry: 1, maxPickupsBeforeDelivery: 1 }
  });
  const routePlan = replan(state);
  const partial = initialPlan(routePlan.state);

  assert.equal(planValue(partial, routePlan.state, routePlan.oracle, routePlan.config), -5);
});

test("enemy competition uses obstacle-aware distance", () => {
  const map = grid(6, 5);
  map[1][4] = "0";
  map[2][4] = "0";
  map[3][4] = "0";
  map[2][3] = "1";
  map[3][3] = "2";
  const plan = replan(
    parseMap({
      width: 6,
      height: 5,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 2 } },
      enemies: [{ id: "E", position: { x: 5, y: 2 }, speed: 1 }],
      greens: [{ id: "G", position: { x: 3, y: 2 }, package: pkg("P", 30) }],
      reds: [{ id: "R", position: { x: 3, y: 3 } }],
      params: { moveWeight: 1, betaCarry: 1, decayRate: 0, maxPickupsBeforeDelivery: 1 }
    })
  );

  assert.deepEqual(plan.sequence, ["START", "G", "R"]);
});

test("ranking distance cache is attached to the normalized planning state", () => {
  const state = parseMap({
    width: 3,
    height: 1,
    grid: [["3", "1", "2"]],
    me: { id: "ME", position: { x: 0, y: 0 } },
    greens: [{ id: "G", position: { x: 1, y: 0 }, package: pkg("P", 10) }],
    reds: [{ id: "R", position: { x: 2, y: 0 } }]
  });
  const plan = replan(state);

  assert.ok(plan.state.__rankingDistanceCache instanceof Map);
  assert.ok(plan.state.__rankingDistanceCache.size > 0);
});
