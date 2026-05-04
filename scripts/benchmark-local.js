import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { replan } from "../src/planner/route-planner.js";

function grid(width, height, fill = "3") {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
}

function pkg(id, value, confidence = 1, decayRate = 0) {
  return { id, value, reward: value, confidence, decayRate };
}

export function defaultBenchmarkCases() {
  const noParcelScout = {
    name: "no parcels visible, greens known",
    expect: (plan) => plan.mode === "SCOUT",
    state: {
      width: 4,
      height: 1,
      grid: [["3", "3", "1", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      params: { decayRate: 0 }
    }
  };

  const parcelVisible = {
    name: "parcel visible",
    expect: (plan) => plan.mode === "PICKUP_DELIVERY",
    state: {
      width: 4,
      height: 1,
      grid: [["3", "1", "3", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [{ id: "G", position: { x: 1, y: 0 }, package: pkg("P", 20) }],
      reds: [{ id: "R", position: { x: 3, y: 0 } }],
      params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
    }
  };

  const carriedParcel = {
    name: "carried parcel",
    expect: (plan) => plan.mode === "DELIVERY_ONLY",
    state: {
      width: 3,
      height: 1,
      grid: [["3", "3", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      carriedPackages: [{ packageId: "C", valueAtPickup: 20, pickupTime: 0, decayRate: 0 }],
      params: { decayRate: 0 }
    }
  };

  const temporaryBlocked = grid(3, 3);
  temporaryBlocked[1][1] = "0";
  temporaryBlocked[1][2] = "1";
  temporaryBlocked[2][2] = "2";

  const twoGreenScout = {
    name: "two green scout",
    expect: (plan) => plan.mode === "SCOUT" && plan.scoutTarget?.id === "G2",
    state: {
      width: 5,
      height: 1,
      grid: [["3", "1", "3", "1", "2"]],
      time: 10,
      me: { id: "ME", position: { x: 0, y: 0 } },
      greens: [
        { id: "G1", position: { x: 1, y: 0 }, package: null },
        { id: "G2", position: { x: 3, y: 0 }, package: null }
      ],
      reds: [{ id: "R", position: { x: 4, y: 0 } }],
      visitedGreenAt: { G1: 9 },
      lastScoutTargetId: "G1",
      params: { decayRate: 0, greenClusterDistance: 1 }
    }
  };

  const congestedTarget = {
    name: "congested target",
    expect: (plan) => plan.mode === "SCOUT" && plan.scoutTarget?.id === "G2",
    state: {
      width: 5,
      height: 1,
      grid: [["3", "1", "3", "1", "2"]],
      me: { id: "ME", position: { x: 0, y: 0 } },
      enemies: [{ id: "E", position: { x: 1, y: 0 }, speed: 1 }],
      greens: [
        { id: "G1", position: { x: 1, y: 0 }, package: null },
        { id: "G2", position: { x: 3, y: 0 }, package: null }
      ],
      reds: [{ id: "R", position: { x: 4, y: 0 } }],
      params: { decayRate: 0, scoutCongestionDistance: 1, scoutCongestionPenalty: 10, greenClusterDistance: 1 }
    }
  };

  return [
    noParcelScout,
    parcelVisible,
    carriedParcel,
    {
      name: "temporary blocked cell",
      expect: (plan) => !plan.path.some((position) => position.x === 1 && position.y === 1),
      state: {
        width: 3,
        height: 3,
        grid: temporaryBlocked,
        me: { id: "ME", position: { x: 0, y: 1 } },
        greens: [{ id: "G", position: { x: 2, y: 1 }, package: pkg("P", 30) }],
        reds: [{ id: "R", position: { x: 2, y: 2 } }],
        params: { decayRate: 0, moveWeight: 1, betaCarry: 1 }
      }
    },
    twoGreenScout,
    congestedTarget,
    {
      name: "B+C beats A",
      expect: (plan) => plan.sequence.includes("B") && plan.sequence.includes("C"),
      state: {
        width: 6,
        height: 1,
        grid: [["1", "3", "1", "1", "2", "3"]],
        me: { id: "ME", position: { x: 1, y: 0 } },
        greens: [
          { id: "A", position: { x: 0, y: 0 }, package: pkg("PA", 100) },
          { id: "B", position: { x: 2, y: 0 }, package: pkg("PB", 60) },
          { id: "C", position: { x: 3, y: 0 }, package: pkg("PC", 70) }
        ],
        reds: [{ id: "R", position: { x: 4, y: 0 } }],
        params: { decayRate: 0, moveWeight: 25, betaCarry: 1, maxPickupsBeforeDelivery: 2 }
      }
    },
    {
      name: "high decay can choose A",
      expect: (plan) => plan.sequence.includes("A") && !plan.sequence.includes("B"),
      state: {
        width: 10,
        height: 2,
        grid: [
          ["3", "1", "3", "3", "3", "3", "1", "1", "3", "3"],
          ["3", "2", "3", "3", "3", "3", "3", "3", "3", "3"]
        ],
        me: { id: "ME", position: { x: 0, y: 0 } },
        greens: [
          { id: "A", position: { x: 1, y: 0 }, package: pkg("PA", 100, 1, 5) },
          { id: "B", position: { x: 6, y: 0 }, package: pkg("PB", 60, 1, 5) },
          { id: "C", position: { x: 7, y: 0 }, package: pkg("PC", 70, 1, 5) }
        ],
        reds: [{ id: "R", position: { x: 1, y: 1 } }],
        params: { decayRate: 5, moveWeight: 1, betaCarry: 1, maxPickupsBeforeDelivery: 2 }
      }
    }
  ];
}

export function loadCases(files = []) {
  if (files.length === 0) return defaultBenchmarkCases();
  return files.flatMap((file) => {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((state, index) => ({
      name: state.name ?? `${file}#${index}`,
      state: state.state ?? state,
      expect: () => true
    }));
  });
}

export function runBenchmarks(cases = defaultBenchmarkCases()) {
  return cases.map((testCase) => {
    const started = performance.now();
    const plan = replan(testCase.state);
    const planningTimeMs = performance.now() - started;
    const passed = testCase.expect(plan);
    return {
      name: testCase.name,
      passed,
      mode: plan.mode,
      sequence: plan.sequence,
      value: plan.value,
      scoutTarget: plan.scoutTarget?.id,
      candidateCount: plan.candidateGreens?.length ?? 0,
      planningTimeMs
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = runBenchmarks(loadCases(process.argv.slice(2)));
  const failed = results.filter((result) => !result.passed);
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}
