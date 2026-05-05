import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CONFIG } from "../src/config.js";
import { buildExecutablePlan } from "../src/planner/executable-plan.js";
import {
  buildDistanceOracle,
  buildDirectedDistanceFields,
  buildMapProfile,
  buildPointsOfInterest,
  buildPickupOnlyPlan,
  chooseConfig,
  fallbackFastPlan,
  futureGreenValue,
  getOracleEdge,
  getDirectedNeighbors,
  informationValueAtWaypoint,
  initialPlan,
  isMoveAllowed,
  isWalkable,
  manhattan,
  planValue,
  parseMap,
  replan,
  reconstructGridPath,
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

function denseGreenState(overrides = {}) {
  const width = 30;
  const height = 30;
  const map = grid(width, height, "1");
  const greens = [];
  const reds = [
    { id: "R_0", position: { x: 29, y: 29 } },
    { id: "R_1", position: { x: 28, y: 29 } },
    { id: "R_2", position: { x: 27, y: 29 } },
    { id: "R_3", position: { x: 26, y: 29 } },
    { id: "R_4", position: { x: 25, y: 29 } }
  ];

  for (const red of reds) {
    map[red.position.y][red.position.x] = "2";
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (map[y][x] !== "1") continue;
      greens.push({ id: `G_${x}_${y}`, position: { x, y }, package: null });
    }
  }

  return parseMap({
    width,
    height,
    grid: map,
    time: overrides.time ?? 100,
    me: overrides.me ?? { id: "ME", position: { x: 14, y: 14 } },
    greens,
    reds,
    lastDeliveryPosition: overrides.lastDeliveryPosition,
    lastObservedAtByTile: overrides.lastObservedAtByTile ?? { "14,14": 100 },
    lastObservedAtByGreen: overrides.lastObservedAtByGreen ?? { "14,14": 100 },
    params: {
      decayRate: 0,
      moveWeight: 1,
      betaCarry: 1,
      ...overrides.params
    }
  });
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

test("candidate selection expands local and cluster packages while respecting maxCandidateGreens", () => {
  const map = grid(12, 5);
  map[2][1] = "1";
  map[2][8] = "1";
  map[3][8] = "1";
  map[2][9] = "1";
  map[2][11] = "2";

  const plan = replan(
    parseMap({
      width: 12,
      height: 5,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 2 } },
      greens: [
        { id: "LOCAL_LOW", position: { x: 1, y: 2 }, package: pkg("local", 1) },
        { id: "GLOBAL_HIGH", position: { x: 8, y: 2 }, package: pkg("global", 100) },
        { id: "CLUSTER_LOW_A", position: { x: 8, y: 3 }, package: pkg("cluster_a", 2) },
        { id: "CLUSTER_LOW_B", position: { x: 9, y: 2 }, package: pkg("cluster_b", 2) }
      ],
      reds: [{ id: "RED", position: { x: 11, y: 2 } }],
      params: {
        decayRate: 0,
        topK: 1,
        localCandidateRadius: 2,
        localCandidateLimit: 2,
        clusterExpansionRadius: 1,
        clusterExpansionLimit: 3,
        maxCandidateGreens: 4
      }
    })
  );

  const ids = plan.candidateGreens.map((green) => green.id);
  assert.ok(ids.includes("GLOBAL_HIGH"));
  assert.ok(ids.includes("LOCAL_LOW"));
  assert.ok(ids.includes("CLUSTER_LOW_A"));
  assert.ok(ids.includes("CLUSTER_LOW_B"));
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, ids.length);
});

test("candidate with failed full sequence never returns pickup delivery START-only", () => {
  const map = grid(4, 1);
  map[0][1] = "1";
  map[0][3] = "2";

  const plan = replan(
    parseMap({
      width: 4,
      height: 1,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      enemies: [{ id: "E", position: { x: 1, y: 0 }, speed: 1 }],
      greens: [{ id: "G", position: { x: 1, y: 0 }, package: pkg("P", 30) }],
      reds: [{ id: "R", position: { x: 3, y: 0 } }],
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1, maxPickupsBeforeDelivery: 1 }
    })
  );

  assert.notDeepEqual({ mode: plan.mode, sequence: plan.sequence }, { mode: "PICKUP_DELIVERY", sequence: ["START"] });
  assert.notEqual(plan.mode, "PICKUP_DELIVERY");
  assert.ok(["PICKUP_ONLY", "SCOUT", "LOCAL_EXPLORE", "IDLE"].includes(plan.mode));
});

test("pickup-only rescue targets a reachable candidate when full pickup delivery fails", () => {
  const map = grid(4, 1);
  map[0][1] = "1";
  map[0][3] = "2";

  const plan = replan(
    parseMap({
      width: 4,
      height: 1,
      grid: map,
      me: { id: "ME", position: { x: 0, y: 0 } },
      enemies: [{ id: "E", position: { x: 1, y: 0 }, speed: 1 }],
      greens: [{ id: "G", position: { x: 1, y: 0 }, package: pkg("P", 30) }],
      reds: [{ id: "R", position: { x: 3, y: 0 } }],
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1, maxPickupsBeforeDelivery: 1 }
    })
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "PICKUP_ONLY");
  assert.deepEqual(plan.sequence, ["START", "G"]);
  assert.deepEqual(actions.map((action) => action.type), ["move", "pick_up"]);
});

test("pickup-only rescue tries all candidates and skips unreachable ones", () => {
  const map = grid(4, 2);
  map[0][1] = "0";
  map[1][1] = "1";
  map[1][3] = "2";
  const state = parseMap({
    width: 4,
    height: 2,
    grid: map,
    me: { id: "ME", position: { x: 0, y: 1 } },
    greens: [
      { id: "G1", position: { x: 1, y: 0 }, package: pkg("P1", 100) },
      { id: "G2", position: { x: 1, y: 1 }, package: pkg("P2", 10) }
    ],
    reds: [{ id: "R", position: { x: 3, y: 1 } }],
    params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
  });
  const profile = buildMapProfile(state);
  const config = chooseConfig(profile, state.params);
  const candidateGreens = state.greens;
  const oracle = buildDistanceOracle(state, buildPointsOfInterest(state, candidateGreens));
  const plan = buildPickupOnlyPlan(state, candidateGreens, oracle, config, profile, new Map());

  assert.equal(plan.mode, "PICKUP_ONLY");
  assert.deepEqual(plan.sequence, ["START", "G2"]);
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
        sensingRange: 2,
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
        sensingRange: 2,
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

test("local explore avoids immediate backtrack when another walkable cell exists", () => {
  const plan = replan(
    parseMap({
      width: 3,
      height: 3,
      grid: grid(3, 3),
      me: { id: "ME", position: { x: 1, y: 1 } },
      lastPosition: { x: 0, y: 1 },
      params: { decayRate: 0, localExploreReversePenalty: 20 }
    })
  );

  assert.equal(plan.mode, "LOCAL_EXPLORE");
  assert.notDeepEqual(plan.path.at(-1), { x: 0, y: 1 });
});

test("local explore still allows backtrack in a corridor", () => {
  const plan = replan(
    parseMap({
      width: 3,
      height: 1,
      grid: [["3", "3", "0"]],
      me: { id: "ME", position: { x: 1, y: 0 } },
      lastPosition: { x: 0, y: 0 },
      params: { decayRate: 0, localExploreReversePenalty: 20 }
    })
  );

  assert.equal(plan.mode, "LOCAL_EXPLORE");
  assert.deepEqual(plan.path.at(-1), { x: 0, y: 0 });
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

test("100 green and 10 red map uses expanded candidate cap and beamWidth", () => {
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
  assert.equal(config.maxCandidateGreens, 16);
  assert.equal(config.beamWidth, 20);
  assert.equal(plan.candidateGreens.length, 16);
});

test("dense-green profile detects all-green maps without giant scout clusters", () => {
  const state = denseGreenState();
  const profile = buildMapProfile(state);

  assert.equal(profile.totalWalkableCells, 900);
  assert.equal(profile.greenCount, 895);
  assert.equal(profile.redCount, 5);
  assert.ok(profile.greenDensity > 0.99);
  assert.equal(profile.isDenseGreen, true);
});

test("dense-green scout bypasses classic huge cluster planning", () => {
  const state = denseGreenState();
  const start = performance.now();
  const plan = replan(state);
  const elapsed = performance.now() - start;
  const actions = buildExecutablePlan(plan);

  assert.notEqual(plan.mode, "SCOUT");
  assert.ok(["DENSE_SCOUT", "LOCAL_EXPLORE", "IDLE"].includes(plan.mode));
  assert.notEqual(plan.scoutTarget?.size, 895);
  assert.ok((plan.scoutTarget?.id?.length ?? 0) < 80);
  assert.ok(elapsed < 100, `dense-green planning took ${elapsed}ms`);
  if (plan.mode === "DENSE_SCOUT") {
    assert.notDeepEqual(plan.scoutTarget.position, state.me.position);
    assert.ok(plan.path.length > 1);
    assert.ok(actions.some((action) => action.type === "move"));
    assert.equal(actions.some((action) => action.type === "pick_up"), false);
  }
});

test("dense scout creates a reachable target away from current and recent delivery cells", () => {
  const state = denseGreenState({
    lastDeliveryPosition: { x: 14, y: 14 },
    params: { denseScoutMinDistanceFromLastDelivery: 2 }
  });
  const plan = replan(state);

  assert.equal(plan.mode, "DENSE_SCOUT");
  assert.notDeepEqual(plan.scoutTarget.position, state.me.position);
  assert.ok(manhattan(plan.scoutTarget.position, state.lastDeliveryPosition) >= 2);
  assert.ok(plan.path.length > 1);
  assert.ok(plan.path.every((position) => isWalkable(plan.state, position)));
});

test("visibility-1 green-exposure scout uses short move-only paths for stale greens", () => {
  const map = grid(7, 5, "0");
  const greens = [];
  for (const position of [
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 4, y: 2 },
    { x: 5, y: 2 },
    { x: 3, y: 1 },
    { x: 3, y: 3 }
  ]) {
    map[position.y][position.x] = "1";
    greens.push({ id: `G_${position.x}_${position.y}`, position, package: null });
  }
  map[3][5] = "3";
  map[4][5] = "2";

  const plan = replan(
    parseMap({
      width: 7,
      height: 5,
      grid: map,
      time: 20,
      me: { id: "ME", position: { x: 1, y: 2 } },
      greens,
      reds: [{ id: "R", position: { x: 5, y: 4 } }],
      lastObservedAtByTile: { "1,2": 20 },
      lastObservedAtByGreen: { "1,2": 20 },
      params: {
        decayRate: 0,
        sensingRange: 2,
        greenExposureDepth: 4,
        greenExposureBeamWidth: 8,
        greenExposureMaxExpanded: 32
      }
    })
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "GREEN_EXPOSURE_SCOUT");
  assert.ok(plan.path.length > 1);
  assert.ok(plan.path.length <= 5);
  assert.ok(plan.scoutTarget.greenVisibleAfterPath > 0);
  assert.ok(plan.scoutTarget.staleGreenVisibleAfterPath > 0);
  assert.equal(actions.every((action) => action.type === "move"), true);
  assert.equal(actions.some((action) => action.type === "pick_up"), false);
});

test("visible parcels still use existing pickup planner instead of exposure scout", () => {
  const config = {
    ...CONFIG,
    planner: {
      ...CONFIG.planner,
      decayRate: 0,
      moveWeight: 1,
      betaCarry: 1,
        sensingRange: 2,
      minParcelConfidence: 0.3
    }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(4, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "1" },
    { x: 2, y: 0, type: "3" },
    { x: 3, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.updateParcelsSensing([{ id: "P", x: 1, y: 0, reward: 25 }], [{ x: 1, y: 0 }]);

  const plan = replan(buildPlannerState(beliefs, config));
  const actions = buildExecutablePlan(plan);

  assert.notEqual(plan.mode, "GREEN_EXPOSURE_SCOUT");
  assert.ok(["PICKUP_DELIVERY", "PICKUP_ONLY"].includes(plan.mode));
  assert.ok(plan.candidateGreens.some((green) => green.package?.id === "P"));
  assert.ok(actions.some((action) => action.type === "pick_up"));
});

test("temporary blocked edges expire and can be reused in corridors", () => {
  const config = {
    ...CONFIG,
    planner: { ...CONFIG.planner, enableEdgeTemporaryBlocks: true, temporaryEdgeBlockTtlTicks: 2 }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.markTemporaryBlockedEdge({ x: 0, y: 0 }, { x: 1, y: 0 }, 2, "test");

  let plannerState = buildPlannerState(beliefs, config);
  assert.equal(isMoveAllowed(plannerState, { x: 0, y: 0 }, { x: 1, y: 0 }), false);

  beliefs.advanceTime(2);
  plannerState = buildPlannerState(beliefs, config);
  assert.equal(isMoveAllowed(plannerState, { x: 0, y: 0 }, { x: 1, y: 0 }), true);
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

test("belief and planner state preserve arrow tile metadata", () => {
  const config = {
    ...CONFIG,
    planner: { ...CONFIG.planner }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(2, 1, [
    { x: 0, y: 0, type: "\u2192" },
    { x: 1, y: 0, type: "3" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });

  const plannerState = buildPlannerState(beliefs, config);

  assert.equal(beliefs.tiles.get("0,0").type, "\u2192");
  assert.equal(plannerState.grid[0][0].directionConstraint, "right");
  assert.equal(plannerState.grid[0][0].blocked, false);
});

test("getDirectedNeighbors is the movement source of truth for arrow exits", () => {
  const state = parseMap({
    width: 3,
    height: 1,
    grid: [["3", "\u2192", "3"]],
    me: { id: "ME", position: { x: 1, y: 0 } }
  });

  assert.deepEqual(getDirectedNeighbors(state, { x: 1, y: 0 }), [{ x: 2, y: 0 }]);
});

test("arrow glyphs use SDK outgoing direction semantics", () => {
  const cases = [
    { tile: "\u2192", allowed: { x: 2, y: 1 }, forbidden: [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 0 }] },
    { tile: "\u2190", allowed: { x: 0, y: 1 }, forbidden: [{ x: 2, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 0 }] },
    { tile: "\u2191", allowed: { x: 1, y: 2 }, forbidden: [{ x: 2, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }] },
    { tile: "\u2193", allowed: { x: 1, y: 0 }, forbidden: [{ x: 2, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 2 }] }
  ];

  for (const testCase of cases) {
    const state = parseMap({
      width: 3,
      height: 3,
      grid: [
        ["3", "3", "3"],
        ["3", testCase.tile, "3"],
        ["3", "3", "3"]
      ],
      me: { id: "ME", position: { x: 1, y: 1 } }
    });
    assert.equal(isMoveAllowed(state, { x: 1, y: 1 }, testCase.allowed), true, testCase.tile);
    for (const forbidden of testCase.forbidden) {
      assert.equal(isMoveAllowed(state, { x: 1, y: 1 }, forbidden), false, testCase.tile);
    }
    assert.equal(buildMapProfile(state).hasDirectionalTiles, true);
  }
});

test("directional maps do not use Manhattan shortcuts when arrows block the direct path", () => {
  const state = parseMap({
    width: 3,
    height: 1,
    grid: [["3", "\u2190", "3"]],
    me: { id: "ME", position: { x: 0, y: 0 } }
  });
  const profile = buildMapProfile(state);
  const path = shortestGridPath(state, { x: 0, y: 0 }, { x: 2, y: 0 }, profile);

  assert.equal(profile.hasDirectionalTiles, true);
  assert.equal(manhattan({ x: 0, y: 0 }, { x: 2, y: 0 }), 2);
  assert.equal(path.cost, Infinity);
});

test("distance oracle preserves directed asymmetry and never reverses paths", () => {
  const state = parseMap({
    width: 2,
    height: 1,
    grid: [["3", "\u2192"]],
    me: { id: "ME", position: { x: 0, y: 0 } }
  });
  const points = [
    { id: "A", type: "start", position: { x: 0, y: 0 } },
    { id: "B", type: "scout", position: { x: 1, y: 0 } }
  ];
  const oracle = buildDistanceOracle(state, points);

  assert.equal(getOracleEdge(oracle, "A", "B").cost, 1);
  assert.equal(getOracleEdge(oracle, "B", "A").cost, Infinity);
  assert.deepEqual(reconstructGridPath(["B", "A"], oracle), []);
});

test("candidate green is rejected when arrows leave no red return path", () => {
  const plan = replan(
    parseMap({
      width: 3,
      height: 1,
      grid: [["3", "\u2190", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [{ id: "G_TRAP", position: { x: 1, y: 0 }, package: pkg("P", 30) }],
      reds: [{ id: "R", position: { x: 2, y: 0 } }],
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
    })
  );
  const diagnostic = plan.candidateDiagnostics.find((entry) => entry.id === "G_TRAP");

  assert.equal(plan.candidateGreens.length, 0);
  assert.equal(diagnostic.reachableFromMe, true);
  assert.equal(diagnostic.reachableRedAfterPickup, false);
  assert.equal(diagnostic.rejectionReason, "no_reachable_red_after_pickup");
});

test("candidate scoring uses long directed red return instead of Manhattan distance", () => {
  const state = parseMap({
    width: 3,
    height: 3,
    grid: [
      ["3", "3", "3"],
      ["3", "\u2191", "2"],
      ["3", "3", "3"]
    ],
    me: { id: "ME", position: { x: 0, y: 1 } },
    greens: [{ id: "G_LONG_RETURN", position: { x: 1, y: 1 }, package: pkg("P", 30) }],
    reds: [{ id: "R", position: { x: 2, y: 1 } }],
    params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
  });
  const fields = buildDirectedDistanceFields(state);

  assert.equal(manhattan({ x: 1, y: 1 }, { x: 2, y: 1 }), 1);
  assert.equal(fields.distToNearestRed.get("1,1"), 3);
  assert.equal(replan(state).candidateGreens[0].id, "G_LONG_RETURN");
});

test("directed red distance is zero only on red cells", () => {
  const state = parseMap({
    width: 3,
    height: 1,
    grid: [["3", "3", "2"]],
    me: { id: "ME", position: { x: 0, y: 0 } },
    reds: [{ id: "R", position: { x: 2, y: 0 } }]
  });
  const fields = buildDirectedDistanceFields(state);

  assert.equal(fields.distToNearestRed.get("2,0"), 0);
  assert.equal(fields.distToNearestRed.get("1,0"), 1);
  assert.equal(fields.distToNearestRed.get("0,0"), 2);
});

test("delivery-only chooses a reachable directed red over a closer unreachable red", () => {
  const plan = replan(
    parseMap({
      width: 2,
      height: 2,
      grid: [
        ["\u2191", "2"],
        ["2", "3"]
      ],
      me: { id: "ME", position: { x: 0, y: 0 } },
      reds: [
        { id: "NEAR_UNREACHABLE", position: { x: 1, y: 0 } },
        { id: "FAR_REACHABLE", position: { x: 0, y: 1 } }
      ],
      carriedPackages: [{ packageId: "C", valueAtPickup: 20, pickupTime: 0, decayRate: 0, confidence: 1 }],
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
    })
  );

  assert.equal(plan.mode, "DELIVERY_ONLY");
  assert.deepEqual(plan.sequence, ["START", "FAR_REACHABLE"]);
  assert.ok(plan.path.every((position, index, path) => index === 0 || isMoveAllowed(plan.state, path[index - 1], position)));
});

test("scout avoids informative endpoints that cannot return to a red through arrows", () => {
  const plan = replan(
    parseMap({
      width: 3,
      height: 3,
      grid: [
        ["3", "\u2192", "3"],
        ["2", "0", "0"],
        ["1", "3", "3"]
      ],
      time: 30,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "TRAP", position: { x: 1, y: 0 }, package: null },
        { id: "SAFE", position: { x: 0, y: 2 }, package: null }
      ],
      reds: [{ id: "R", position: { x: 0, y: 1 } }],
      lastObservedAtByTile: { "0,0": 30, "0,2": 28 },
      lastObservedAtByGreen: { "0,2": 28 },
      params: {
        decayRate: 0,
        sensingRange: 2,
        greenClusterDistance: 1,
        returnToRedWeight: 0.5,
        trapPenalty: 10000
      }
    })
  );

  assert.notDeepEqual(plan.scoutTarget?.position, { x: 1, y: 0 });
  assert.equal(plan.scoutTarget?.trapPenaltyApplied, false);
  assert.ok(Number.isFinite(plan.scoutTarget?.distanceToNearestRed));
});

test("green-exposure scout follows directed arrows and keeps a red return", () => {
  const state = parseMap({
    width: 4,
    height: 2,
    grid: [
      ["\u2192", "3", "3", "2"],
      ["1", "1", "1", "3"]
    ],
    time: 20,
    me: { id: "ME", position: { x: 0, y: 0 } },
    reds: [{ id: "R", position: { x: 3, y: 0 } }],
    params: {
      decayRate: 0,
      sensingRange: 1,
      greenExposureDepth: 4,
      greenExposureBeamWidth: 8,
      greenExposureMaxExpanded: 20
    }
  });
  const plan = replan(state);

  assert.equal(plan.mode, "GREEN_EXPOSURE_SCOUT");
  for (let i = 0; i < plan.path.length - 1; i += 1) {
    assert.equal(isMoveAllowed(plan.state, plan.path[i], plan.path[i + 1]), true);
  }
  assert.ok(Number.isFinite(plan.scoutTarget.distanceToNearestRed));
});

test("green-exposure scout prefers multi-step plans when alternatives exist", () => {
  const state = parseMap({
    width: 6,
    height: 2,
    grid: [
      ["3", "3", "3", "3", "3", "2"],
      ["1", "1", "1", "1", "1", "3"]
    ],
    time: 20,
    me: { id: "ME", position: { x: 0, y: 0 } },
    reds: [{ id: "R", position: { x: 5, y: 0 } }],
    params: {
      decayRate: 0,
      sensingRange: 1,
      greenExposureMinPlanLength: 3,
      greenExposureDepth: 6,
      greenExposureBeamWidth: 16,
      greenExposureMaxExpanded: 64
    }
  });
  const plan = replan(state);
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "GREEN_EXPOSURE_SCOUT");
  assert.ok(actions.length >= 3);
});

test("green-exposure scout does not choose a negative score as a normal plan", () => {
  const state = parseMap({
    width: 3,
    height: 1,
    grid: [["3", "1", "2"]],
    time: 20,
    me: { id: "ME", position: { x: 0, y: 0 } },
    reds: [{ id: "R", position: { x: 2, y: 0 } }],
    visitedPositions: { "1,0": 20 },
    visitedEdges: { "0,0->1,0": 20 },
    params: {
      decayRate: 0,
      sensingRange: 1,
      minGreenExposureScore: 0,
      positionRevisitPenalty: 100,
      edgeRevisitPenalty: 100,
      greenExposureDepth: 2
    }
  });
  const plan = replan(state);

  assert.notEqual(plan.mode, "GREEN_EXPOSURE_SCOUT");
});

test("temporary blocked edges are excluded from directed fields and oracle until TTL expires", () => {
  const config = {
    ...CONFIG,
    planner: { ...CONFIG.planner, enableEdgeTemporaryBlocks: true, temporaryEdgeBlockTtlTicks: 2 }
  };
  const beliefs = new BeliefState(config);
  beliefs.updateMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "2" }
  ]);
  beliefs.updateSelf({ id: "ME", name: "me", x: 0, y: 0, score: 0, penalty: 0 });
  beliefs.markTemporaryBlockedEdge({ x: 0, y: 0 }, { x: 1, y: 0 }, 2, "test");

  let plannerState = buildPlannerState(beliefs, config);
  let fields = buildDirectedDistanceFields(plannerState);
  let oracle = buildDistanceOracle(plannerState, buildPointsOfInterest(plannerState, []));
  assert.equal(fields.distFromMe.has("1,0"), false);
  assert.equal(getOracleEdge(oracle, "START", "R_2_0").cost, Infinity);

  beliefs.advanceTime(2);
  plannerState = buildPlannerState(beliefs, config);
  fields = buildDirectedDistanceFields(plannerState);
  oracle = buildDistanceOracle(plannerState, buildPointsOfInterest(plannerState, []));
  assert.equal(fields.distFromMe.get("1,0"), 1);
  assert.equal(getOracleEdge(oracle, "START", "R_2_0").cost, 2);
});

test("arrow map fixtures produce valid directed plans and reject impossible returns", () => {
  const fixtures = [
    parseMap({
      width: 3,
      height: 3,
      grid: [
        ["1", "3", "2"],
        ["3", "\u2191", "2"],
        ["0", "3", "0"]
      ],
      me: { id: "ME", position: { x: 0, y: 1 } },
      greens: [
        { id: "TRAP_NEAR_RED", position: { x: 1, y: 1 }, package: pkg("TRAP", 80) },
        { id: "SAFE_RETURN", position: { x: 0, y: 0 }, package: pkg("SAFE", 30) }
      ],
      reds: [
        { id: "SAFE_RED", position: { x: 2, y: 0 } },
        { id: "NEAR_RED", position: { x: 2, y: 1 } }
      ],
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
    }),
    parseMap({
      width: 4,
      height: 2,
      grid: [
        ["\u2192", "3", "3", "2"],
        ["1", "1", "1", "3"]
      ],
      me: { id: "ME", position: { x: 0, y: 0 } },
      reds: [{ id: "R", position: { x: 3, y: 0 } }],
      params: { decayRate: 0, sensingRange: 1, greenExposureDepth: 4 }
    })
  ];

  for (const state of fixtures) {
    const plan = replan(state);
    assert.equal(plan.profile.hasDirectionalTiles, true);
    for (let i = 0; i < plan.path.length - 1; i += 1) {
      assert.equal(isMoveAllowed(plan.state, plan.path[i], plan.path[i + 1]), true);
    }
    assert.equal(plan.candidateGreens.some((green) => green.id === "TRAP_NEAR_RED"), false);
  }

  const trapDiagnostic = replan(fixtures[0]).candidateDiagnostics.find((entry) => entry.id === "TRAP_NEAR_RED");
  assert.equal(trapDiagnostic.rejectionReason, "no_reachable_red_after_pickup");
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

test("fast cloud config clamps expensive planner knobs", () => {
  const state = parseMap({
    width: 12,
    height: 1,
    grid: [Array.from({ length: 12 }, (_, index) => (index === 11 ? "2" : "1"))],
    me: { id: "ME", position: { x: 0, y: 0 } },
    params: { fastCloudMode: true }
  });
  const cfg = chooseConfig(buildMapProfile(state), state.params);

  assert.equal(cfg.fastCloudMode, true);
  assert.ok(cfg.maxCandidateGreens <= 8);
  assert.ok(cfg.greenExposureDepth <= 4);
  assert.ok(cfg.greenExposureMaxExpanded <= 24);
  assert.ok(cfg.hardPlanningBudgetMs <= 60);
});

test("hard budget uses fallbackFastPlan in fast cloud mode", () => {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => {
    now += 100;
    return now;
  };

  try {
    const plan = replan(
      parseMap({
        width: 3,
        height: 1,
        grid: [["3", "1", "2"]],
        me: { id: "ME", position: { x: 0, y: 0 } },
        greens: [{ id: "G", position: { x: 1, y: 0 }, package: pkg("P", 10) }],
        reds: [{ id: "R", position: { x: 2, y: 0 } }],
        params: { fastCloudMode: true, hardPlanningBudgetMs: 60, decayRate: 0 }
      })
    );

    assert.equal(plan.fallbackStage, "hard_budget_fallback");
    assert.ok(["PICKUP_ONLY", "LOCAL_EXPLORE_FAST", "LOCAL_EXPLORE", "IDLE"].includes(plan.mode));
  } finally {
    Date.now = originalNow;
  }
});

test("fast cloud mode keeps large-map planning under a small wall-clock budget", () => {
  const state = denseGreenState({
    params: {
      fastCloudMode: true,
      sensingRange: 1,
      hardPlanningBudgetMs: 60,
      planningBudgetMs: 25
    }
  });
  const started = performance.now();
  const plan = replan(state);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 100, `expected fast cloud planning under 100ms, got ${elapsed}`);
  assert.notEqual(plan.mode, "SCOUT");
});

test("fallbackFastPlan delivers carried packages with a directed red path", () => {
  const plan = fallbackFastPlan(
    parseMap({
      width: 3,
      height: 1,
      grid: [["3", "3", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      carriedPackages: [{ id: "C", valueAtPickup: 20, pickupTime: 0, decayRate: 0, confidence: 1 }],
      reds: [{ id: "R", position: { x: 2, y: 0 } }],
      params: { fastCloudMode: true, decayRate: 0 }
    }),
    { fastCloudMode: true, decayRate: 0 }
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "DELIVERY_ONLY");
  assert.deepEqual(plan.sequence, ["START", "R"]);
  assert.equal(actions.at(-1).type, "put_down");
});

test("fallbackFastPlan picks a visible reachable package without full beam search", () => {
  const plan = fallbackFastPlan(
    parseMap({
      width: 3,
      height: 1,
      grid: [["3", "1", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [{ id: "G", position: { x: 1, y: 0 }, package: { ...pkg("P", 20), lastSeenTime: 0 } }],
      reds: [{ id: "R", position: { x: 2, y: 0 } }],
      params: { fastCloudMode: true, decayRate: 0 }
    }),
    { fastCloudMode: true, decayRate: 0 }
  );
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "PICKUP_ONLY");
  assert.deepEqual(plan.sequence, ["START", "G"]);
  assert.ok(actions.some((action) => action.type === "pick_up"));
});

test("fallbackFastPlan scout is short and respects arrow constraints", () => {
  const state = parseMap({
    width: 5,
    height: 1,
    grid: [["3", "\u2192", "\u2192", "3", "2"]],
    me: { id: "ME", position: { x: 0, y: 0 } },
    reds: [{ id: "R", position: { x: 4, y: 0 } }],
    params: { fastCloudMode: true, sensingRange: 1, decayRate: 0 }
  });
  const plan = fallbackFastPlan(state, { fastCloudMode: true, sensingRange: 1, decayRate: 0 });
  const actions = buildExecutablePlan(plan);

  assert.equal(plan.mode, "LOCAL_EXPLORE_FAST");
  assert.ok(actions.length >= 2);
  assert.ok(actions.length <= 3);
  for (const action of actions) {
    if (action.type === "move") assert.equal(isMoveAllowed(plan.state, action.from, action.to), true);
  }
});
