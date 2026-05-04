import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { TUNABLE_PARAMS } from "../src/config/tunable-params.js";
import { replan } from "../src/planner/route-planner.js";
import { defaultBenchmarkCases, loadCases } from "./benchmark-local.js";

const DEFAULT_RANGES = Object.freeze({
  moveWeight: [0.2, 4],
  betaCarry: [0.1, 1.5],
  kWin: [0.2, 3],
  rhoGeneration: [0, 0.5],
  targetCongestionPenalty: [0, 15],
  scoutCooldownTicks: [2, 20],
  recentScoutPenalty: [0, 30],
  sameScoutTargetPenalty: [0, 40],
  deliveryUrgencyWeight: [0, 10],
  clusterPickupRadius: [1, 6],
  clusterPickupBonusWeight: [0, 1.5],
  minClusterPackageValue: [0, 10],
  infoValueWeight: [0.2, 3],
  maxStalenessValue: [5, 40],
  greenInfoMultiplier: [1, 5],
  emptyGreenFutureWeight: [0, 0.2],
  greenClusterDistance: [1, 4],
  clusterSizeWeight: [0, 5],
  explorationDebtThreshold: [10, 60],
  explorationDebtBonus: [0, 40],
  opportunisticMaxDistance: [1, 5],
  opportunisticPathRadius: [1, 4],
  opportunisticMinGain: [0, 20],
  opportunisticCongestionPenalty: [0, 20],
  beamWidth: [10, 120],
  topK: [4, 20],
  maxPickupsBeforeDelivery: [1, 5]
});

function parseArgs(argv) {
  const args = { files: [], trials: 50, ranges: DEFAULT_RANGES };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--trials") {
      args.trials = Math.max(1, Number(argv[i + 1]) || args.trials);
      i += 1;
    } else if (arg === "--ranges") {
      args.ranges = { ...DEFAULT_RANGES, ...JSON.parse(readFileSync(argv[i + 1], "utf8")) };
      i += 1;
    } else {
      args.files.push(arg);
    }
  }

  return args;
}

function sampleParam(name, range) {
  const [min, max] = range;
  const value = min + Math.random() * (max - min);
  if (
    [
      "beamWidth",
      "topK",
      "maxPickupsBeforeDelivery",
      "scoutCooldownTicks",
      "clusterPickupRadius",
      "greenClusterDistance",
      "explorationDebtThreshold",
      "opportunisticMaxDistance",
      "opportunisticPathRadius"
    ].includes(name)
  ) {
    return Math.max(1, Math.round(value));
  }
  return Number(value.toFixed(4));
}

function sampleConfig(ranges) {
  const params = {};
  for (const name of TUNABLE_PARAMS) {
    if (!ranges[name]) continue;
    params[name] = sampleParam(name, ranges[name]);
  }
  return params;
}

function scorePlan(plan, testCase) {
  const expected = testCase.expect?.(plan) ? 100 : -100;
  const value = Number.isFinite(Number(plan.value)) ? Number(plan.value) : 0;
  const movement = Array.isArray(plan.path) ? plan.path.length : 0;
  return expected + value - movement * 0.1;
}

export function evaluateConfig(cases, params) {
  const scores = [];
  const times = [];

  for (const testCase of cases) {
    const state = {
      ...testCase.state,
      params: {
        ...(testCase.state.params ?? {}),
        ...params
      }
    };
    const started = performance.now();
    const plan = replan(state);
    times.push(performance.now() - started);
    scores.push(scorePlan(plan, testCase));
  }

  return {
    scoreMean: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    scoreMin: Math.min(...scores),
    planningTimeMsMean: times.reduce((sum, time) => sum + time, 0) / times.length
  };
}

export function randomParamSearch({ cases = defaultBenchmarkCases(), trials = 50, ranges = DEFAULT_RANGES } = {}) {
  let best = null;

  for (let trial = 0; trial < trials; trial += 1) {
    const params = sampleConfig(ranges);
    const result = evaluateConfig(cases, params);
    const candidate = { trial, params, ...result };

    if (
      !best ||
      candidate.scoreMean > best.scoreMean ||
      (candidate.scoreMean === best.scoreMean && candidate.scoreMin > best.scoreMin)
    ) {
      best = candidate;
    }
  }

  return best;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const cases = args.files.length > 0 ? loadCases(args.files) : defaultBenchmarkCases();
  const best = randomParamSearch({ cases, trials: args.trials, ranges: args.ranges });
  console.log(JSON.stringify({ trials: args.trials, best }, null, 2));
}
