import { buildDistanceOracle, getOracleEdge, reconstructGridPath } from "../path/distance-oracle.js";
import { asNumber, buildMapProfile, copyPosition } from "../path/grid-utils.js";
import { baseRoutePlan } from "../route-plan.js";
import { hasAvailablePackage, packageConfidence } from "../scoring/green-scorer.js";
import {
  extendToGreen,
  extendToRed,
  initialPlan,
  partialPlanPriority,
  planValue
} from "./plan-search.js";

function visibleReliableGreen(state, green, config) {
  if (!hasAvailablePackage(green, config)) return false;
  const lastSeen = asNumber(green.package?.lastSeenTime, -Infinity);
  return packageConfidence(green) >= 1 || lastSeen >= asNumber(state.time, 0);
}

function pointsFor(state, greens) {
  return [
    { id: "START", type: "start", position: copyPosition(state.me.position) },
    ...greens.map((green) => ({ ...green, type: "green", position: copyPosition(green.position) })),
    ...(state.reds ?? []).map((red) => ({ ...red, type: "red", position: copyPosition(red.position) }))
  ];
}

function rankCandidates(state, greens, oracle, config) {
  const rows = [];
  for (const green of greens) {
    const edge = getOracleEdge(oracle, "START", green.id);
    if (!edge || !Number.isFinite(edge.cost)) continue;
    const reward = asNumber(green.package?.value ?? green.package?.reward, config.meanPackageValue);
    rows.push({
      green,
      score: reward / Math.max(1, edge.cost),
      distance: edge.cost
    });
  }
  rows.sort((a, b) => b.score - a.score || a.distance - b.distance || a.green.id.localeCompare(b.green.id));
  return rows.map((row) => row.green);
}

export function buildShortHarvestPlan(plannerState, deliveryDecision, config = {}) {
  if (deliveryDecision?.shouldDeliver !== false) return null;

  const budgetMs = Math.max(1, asNumber(config.shortHarvestBudgetMs, 20));
  const startedAt = Date.now();
  const maxCandidates = Math.max(1, Math.round(asNumber(config.shortHarvestMaxCandidates, 8)));
  const minCandidates = Math.max(1, Math.round(asNumber(config.shortHarvestMinCandidates, 2)));
  const maxDepth = Math.max(1, Math.round(asNumber(config.shortHarvestDepth, 4)));
  const beamWidth = Math.max(1, Math.round(asNumber(config.shortHarvestBeamWidth, 8)));
  const minValue = asNumber(config.shortHarvestMinValue, 0);

  const profile = plannerState.__mapProfile ?? buildMapProfile(plannerState);
  const initialGreens = (plannerState.greens ?? []).filter((green) => visibleReliableGreen(plannerState, green, config));
  if (initialGreens.length < minCandidates || (plannerState.reds ?? []).length === 0) return null;

  const preliminaryOracle = buildDistanceOracle(plannerState, pointsFor(plannerState, initialGreens));
  const candidateGreens = rankCandidates(plannerState, initialGreens, preliminaryOracle, config).slice(0, maxCandidates);
  if (candidateGreens.length < minCandidates) return null;

  const points = pointsFor(plannerState, candidateGreens);
  const oracle = buildDistanceOracle(plannerState, points);
  const reds = points.filter((point) => point.type === "red");
  let beam = [initialPlan(plannerState)];
  let best = null;
  let bestValue = -Infinity;
  let bestReason = "short_harvest_no_sequence";

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (Date.now() - startedAt >= budgetMs) break;
    const nextRows = [];

    for (const plan of beam) {
      if (Date.now() - startedAt >= budgetMs) break;

      for (const red of reds) {
        const delivered = extendToRed(plan, red, plannerState, oracle, config);
        if (!delivered) continue;
        const value = planValue(delivered, plannerState, oracle, config);
        if (value > bestValue) {
          best = delivered;
          bestValue = value;
          bestReason = "short_harvest_delivery_best";
        }
      }

      for (const green of candidateGreens) {
        const next = extendToGreen(plan, green, plannerState, oracle, config);
        if (!next) continue;
        const priority = partialPlanPriority(next, candidateGreens, reds, plannerState, oracle, config);
        const value = planValue(next, plannerState, oracle, config);
        nextRows.push({ plan: next, priority, value });
      }
    }

    if (nextRows.length === 0) break;
    nextRows.sort((a, b) => b.priority - a.priority || b.value - a.value);
    beam = nextRows.slice(0, beamWidth).map((row) => row.plan);
  }

  if (!best || bestValue <= minValue) return null;

  const path = reconstructGridPath(best.sequence, oracle);
  if (!Array.isArray(path) || path.length === 0) return null;

  return {
    ...baseRoutePlan({
      mode: "PICKUP_DELIVERY_UNIFIED",
      sequence: best.sequence,
      path,
      value: bestValue,
      plan: { ...best, value: bestValue },
      profile,
      config,
      greenScores: {},
      candidateGreens,
      oracle,
      state: plannerState,
      fallbackStage: "short_harvest_rollout"
    }),
    type: "SHORT_HARVEST",
    shortHarvest: true,
    reason: bestReason,
    deliveryDecision
  };
}
