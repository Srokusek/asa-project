import { manhattan } from "../../utils/geometry.js";
import { normalizeSensingRange, sensingRangeSignature } from "../../state/belief-state.js";
import { DEFAULT_PARAMS } from "../default-params.js";
import { baseRoutePlan } from "../route-plan.js";
import { initialPlan } from "../search/plan-search.js";
import { asNumber, copyPosition, isWalkable, positionKey, getCell } from "../path/grid-utils.js";
import { bfsAllDistancesFrom, distanceToNearestReachableRed, pathFromBfsAll, shortestGridPath } from "../path/pathfinder.js";
import { pickupMultiplierAt } from "../scoring/green-scorer.js";

function pairKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

function returnToRedInfo(state, position) {
  const distance = distanceToNearestReachableRed(state, position);
  if (!Number.isFinite(distance)) {
    return {
      distanceToNearestRed: Infinity,
      trapPenaltyApplied: state.reds?.length > 0
    };
  }
  return {
    distanceToNearestRed: distance,
    trapPenaltyApplied: false
  };
}

function routePlanForScoutPoint({ mode, state, profile, config, greenScores, pointId, point, edge, value, scoutTarget }) {
  const startPoint = { id: "START", type: "start", position: copyPosition(state.me.position) };
  const scoutPoint = {
    id: pointId,
    type: "scout",
    position: copyPosition(point),
    noPickup: true
  };
  const oracle = {
    entries: new Map([
      [
        pairKey("START", pointId),
        {
          fromId: "START",
          toId: pointId,
          cost: edge.cost,
          path: edge.path
        }
      ]
    ]),
    points: [startPoint, scoutPoint],
    pointsById: new Map([
      ["START", startPoint],
      [pointId, scoutPoint]
    ]),
    profile
  };

  return baseRoutePlan({
    mode,
    sequence: ["START", pointId],
    path: edge.path.map(copyPosition),
    value,
    plan: initialPlan(state),
    profile,
    config,
    greenScores,
    candidateGreens: [],
    scoutTarget: {
      ...scoutTarget,
      distanceFromMe: scoutTarget?.distanceFromMe ?? edge.cost,
      distanceToNearestRed: scoutTarget?.distanceToNearestRed ?? returnToRedInfo(state, point).distanceToNearestRed,
      trapPenaltyApplied: Boolean(scoutTarget?.trapPenaltyApplied)
    },
    oracle,
    state
  });
}

function checkpointId(position, config) {
  const sector = sectorIdFor(position, config);
  return `SCOUT_UNIFIED_${position.x}_${position.y}_S${sector}`;
}

function checkpointCoverageSort(a, b) {
  return b.coveredGreenIds.length - a.coveredGreenIds.length || a.id.localeCompare(b.id);
}

export function buildScoutCheckpointSignature(state, config, profile = null) {
  // get an id for each if the generated checkpoints
  const greens = [...(state.greens ?? [])]
    .map((green) => `${green.position.x},${green.position.y}`)
    .sort()
    .join("|");
  const walkableGreens = [...(state.greens ?? [])]
    .map((green) => copyPosition(green.position))
    .filter((position) => isWalkable(state, position))
    .map((position) => `${position.x},${position.y}`)
    .sort()
    .join("|");
  const sensingRange = normalizeSensingRange(config.sensingRange, DEFAULT_PARAMS.sensingRange);
  return [
    state.width,
    state.height,
    sensingRangeSignature(sensingRange),
    Boolean(profile?.hasDirectionalTiles),
    Boolean(profile?.hasObstacles),
    greens,
    walkableGreens
  ].join("::");
}

function isRejectedOrchestrationScoutTarget(state, green) {
  if (!green.orchestrationRuleId) return false;

  const cell = getCell(state, green.position);
  return cell?.rawType === "5" || cell?.rawType === "5!";
}

export function buildScoutCheckpointIndex(state, config, profile = null, signature = null) {
  const maxCheckpoints = Math.max(1, Math.round(asNumber(config.unifiedScoutCheckpointCount, 24)));
  const sensingRange = normalizeSensingRange(config.sensingRange, DEFAULT_PARAMS.sensingRange);
  const greenById = new Map((state.greens ?? []).map((green) => [green.id, green]));
  const candidates = [];
  const allGreenIds = (state.greens ?? []).map((green) => green.id).sort();

  for (const green of state.greens ?? []) {
    if (isRejectedOrchestrationScoutTarget(state, green)) continue;
    const position = copyPosition(green.position);
    if (!isWalkable(state, position)) continue;
    const coveredGreenIds =
      sensingRange === Infinity
        ? [...allGreenIds]
        : (state.greens ?? [])
            .filter((target) => manhattan(position, target.position) <= sensingRange)
            .map((target) => target.id);
    if (coveredGreenIds.length === 0) continue;
    const id = checkpointId(position, config);
    candidates.push({
      id,
      position,
      coveredGreenIds: coveredGreenIds.sort(),
      staticCoverageSize: coveredGreenIds.length
    });
  }

  candidates.sort(checkpointCoverageSort);
  const uncovered = new Set([...greenById.keys()]);
  const selected = [];

  while (selected.length < maxCheckpoints) {
    let best = null;
    let bestGain = -1;

    for (const candidate of candidates) {
      if (selected.some((entry) => entry.id === candidate.id)) continue;
      let uncoveredGain = 0;
      for (const greenId of candidate.coveredGreenIds) {
        if (uncovered.has(greenId)) uncoveredGain += 1;
      }
      if (uncoveredGain <= 0) continue;
      if (uncoveredGain > bestGain) {
        best = candidate;
        bestGain = uncoveredGain;
        continue;
      }
      if (uncoveredGain === bestGain && best && candidate.id.localeCompare(best.id) < 0) {
        best = candidate;
      }
    }

    if (!best) break;
    selected.push(best);
    for (const greenId of best.coveredGreenIds) uncovered.delete(greenId);
  }

  return {
    signature: signature ?? buildScoutCheckpointSignature(state, config, profile),
    checkpointCount: selected.length,
    checkpoints: selected,
    uncoveredGreenCount: uncovered.size
  };
}

function unifiedScoutRepeatPenalty(state, checkpointIdValue, sectorId, config) {
  const now = asNumber(state.time, 0);
  const cooldown = asNumber(config.failedScoutTargetCooldownTicks, DEFAULT_PARAMS.failedScoutTargetCooldownTicks);
  const attempt = state.scoutTargetAttempts?.[checkpointIdValue];
  const targetRecent = attempt && now - asNumber(attempt.lastAttemptTick, -Infinity) <= cooldown;
  const sectorRecent = (state.recentScoutTargets ?? []).some((id) => String(id).includes(`_S${sectorId}`));
  return (
    (targetRecent ? asNumber(config.unifiedScoutRepeatTargetPenalty, 20) : 0) +
    (sectorRecent ? asNumber(config.unifiedScoutRepeatSectorPenalty, 10) : 0)
  );
}

export function buildUnifiedScoutPlan(state, profile, config, greenScores, checkpointIndex) {
  const checkpoints = checkpointIndex?.checkpoints ?? [];
  if (checkpoints.length === 0) return null;

  const start = copyPosition(state.me.position);
  const stalenessCap = Math.max(1, asNumber(config.maxStalenessValue, DEFAULT_PARAMS.maxStalenessValue));
  const exposureWeight = Math.max(0, asNumber(config.unifiedScoutExposureWeight, 1));
  const distanceWeight = Math.max(0, asNumber(config.unifiedScoutDistanceWeight, 1));
  const startSearch = profile.hasUniformCosts ? bfsAllDistancesFrom(state, state.me.position) : null;
  const greenById = new Map((state.greens ?? []).map((green) => [green.id, green]));
  const candidates = [];

  for (const checkpoint of checkpoints) {
    const position = copyPosition(checkpoint.position);
    const edge = startSearch
      ? pathFromBfsAll(startSearch, position)
      : shortestGridPath(state, start, position, profile);
    if (!Number.isFinite(edge.cost) || edge.path.length <= 1) continue;

    let normalizedStalenessSum = 0;
    let multiplierSum = 0;
    let coveredGreenCount = 0;
    for (const greenId of checkpoint.coveredGreenIds ?? []) {
      const green = greenById.get(greenId);
      if (!green) continue;
      const observedAt = state.lastObservedAtByTile?.[positionKey(green.position)];
      const staleness =
        observedAt === undefined
          ? stalenessCap
          : Math.max(0, asNumber(state.time, 0) - asNumber(observedAt, 0));
      const normalizedStaleness = Math.min(stalenessCap, staleness) / stalenessCap;
      const multiplier = pickupMultiplierAt(state, green.position);
      multiplierSum += multiplier;
      normalizedStalenessSum += normalizedStaleness;
      coveredGreenCount += 1;
    }
    if (coveredGreenCount === 0) continue;

    const checkpointStaleness = normalizedStalenessSum / coveredGreenCount;
    const averageMultiplier = multiplierSum / coveredGreenCount;
    const meanPackageValue = asNumber(
      state.meanPackageValue ?? config.meanPackageValue,
      DEFAULT_PARAMS.meanPackageValue
    );
    const exposureValue =
      averageMultiplier * checkpointStaleness * coveredGreenCount * meanPackageValue;
    const exposureScore = exposureWeight * exposureValue;
    const redInfo = returnToRedInfo(state, position);
    if (redInfo.trapPenaltyApplied) continue;
    const totalTravelDistance = edge.cost + redInfo.distanceToNearestRed;
    const distanceScore = distanceWeight * totalTravelDistance;
    const sector = sectorIdFor(position, config);
    const repeatPenalty = unifiedScoutRepeatPenalty(state, checkpoint.id, sector, config);
    const score = exposureScore - distanceScore - repeatPenalty;

    candidates.push({
      checkpoint,
      position,
      edge,
      exposureValue,
      exposureScore,
      distanceScore,
      totalTravelDistance,
      checkpointStaleness,
      averageMultiplier,
      coveredGreenCount,
      repeatPenalty,
      distanceToNearestRed: redInfo.distanceToNearestRed,
      score
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.totalTravelDistance - b.totalTravelDistance ||
      a.edge.cost - b.edge.cost ||
      a.checkpoint.id.localeCompare(b.checkpoint.id)
  );
  const best = candidates[0];

  return routePlanForScoutPoint({
    mode: "SCOUT_UNIFIED",
    state,
    profile,
    config,
    greenScores,
    pointId: best.checkpoint.id,
    point: best.position,
    edge: best.edge,
    value: best.score,
    scoutTarget: {
      id: best.checkpoint.id,
      position: copyPosition(best.position),
      score: best.score,
      exposureValue: best.exposureValue,
      exposureScore: best.exposureScore,
      distanceScore: best.distanceScore,
      totalTravelDistance: best.totalTravelDistance,
      checkpointStaleness: best.checkpointStaleness,
      averageMultiplier: best.averageMultiplier,
      repeatPenalty: best.repeatPenalty,
      coveredGreenCount: best.coveredGreenCount,
      sampleGreenIds: (best.checkpoint.coveredGreenIds ?? []).slice(0, 8),
      staticCoverageSize: best.checkpoint.staticCoverageSize,
      checkpointSignature: checkpointIndex?.signature ?? null,
      checkpointCount: checkpointIndex?.checkpointCount ?? checkpoints.length,
      checkpointUncoveredGreenCount: checkpointIndex?.uncoveredGreenCount ?? null,
      distanceFromMe: best.edge.cost,
      pathCost: best.edge.cost,
      distanceToNearestRed: best.distanceToNearestRed
    }
  });
}

function sectorIdFor(position, config) {
  const size = Math.max(1, asNumber(config.coverageSectorSize, DEFAULT_PARAMS.coverageSectorSize));
  return `${Math.floor(position.x / size)},${Math.floor(position.y / size)}`;
}
