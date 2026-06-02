import { manhattan } from "../../utils/geometry.js";
import { DEFAULT_PARAMS } from "../default-params.js";
import { baseRoutePlan } from "../route-plan.js";
import { initialPlan } from "../search/plan-search.js";
import { asNumber, copyPosition, getCell, isWalkable, positionKey } from "../path/grid-utils.js";
import { bfsAllDistancesFrom, distanceToNearestReachableRed, pathFromBfsAll, shortestGridPath } from "../path/pathfinder.js";
import { hasAvailablePackage, packageConfidence, pickupMultiplierAt } from "../scoring/green-scorer.js";

function pairKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

export function tileInformationValue(state, position, config) {
  const cell = getCell(state, position);
  if (!cell || cell.blocked) return 0;

  const key = positionKey(position);
  const observedMap = cell.type === "green" ? state.lastObservedAtByGreen : state.lastObservedAtByTile;
  const fallbackMap = state.lastObservedAtByTile;
  const last = observedMap?.[key] ?? fallbackMap?.[key];
  const staleness =
    last === undefined ? config.maxStalenessValue : Math.max(0, asNumber(state.time, 0) - asNumber(last, 0));

  let base = Math.min(config.maxStalenessValue, staleness);
  if (cell.type === "green") base *= config.greenInfoMultiplier;
  if (cell.type === "red") base *= config.redInfoMultiplier;
  return base;
}

export function visibleAvailablePackages(state, config) {
  return state.greens.filter((green) => {
    if (!hasAvailablePackage(green, config)) return false;
    const lastSeen = asNumber(green.package?.lastSeenTime, NaN);
    return packageConfidence(green) >= 1 || lastSeen >= asNumber(state.time, 0);
  });
}

function returnToRedPenalty(state, position, config) { // penalty for getting trapped or long travel distance
  const distance = distanceToNearestReachableRed(state, position);
  if (!Number.isFinite(distance)) {
    return {
      distanceToNearestRed: Infinity,
      penalty: state.reds?.length > 0 ? asNumber(config.trapPenalty, DEFAULT_PARAMS.trapPenalty) : 0,
      trapPenaltyApplied: state.reds?.length > 0
    };
  }
  return {
    distanceToNearestRed: distance,
    penalty: asNumber(config.returnToRedWeight, DEFAULT_PARAMS.returnToRedWeight) * distance,
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
      distanceToNearestRed: scoutTarget?.distanceToNearestRed ?? returnToRedPenalty(state, point, config).distanceToNearestRed,
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

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function checkpointCoverageSort(a, b) {
  return b.coveredGreenIds.length - a.coveredGreenIds.length;
}

export function buildScoutCheckpointSignature(state, config, profile = null) {
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
  const sensingRange = Math.max(0, asNumber(config.sensingRange, DEFAULT_PARAMS.sensingRange));
  return [
    state.width,
    state.height,
    sensingRange,
    Boolean(profile?.hasDirectionalTiles),
    Boolean(profile?.hasObstacles),
    greens,
    walkableGreens
  ].join("::");
}

export function buildScoutCheckpointIndex(state, config, profile = null, signature = null) {
  const maxCheckpoints = Math.max(1, Math.round(asNumber(config.unifiedScoutCheckpointCount, 24)));
  const sensingRange = Math.max(0, asNumber(config.sensingRange, DEFAULT_PARAMS.sensingRange));
  const greenById = new Map((state.greens ?? []).map((green) => [green.id, green]));
  const candidates = [];

  for (const green of state.greens ?? []) {
    const position = copyPosition(green.position);
    if (!isWalkable(state, position)) continue;
    const coveredGreenIds = [];
    for (const target of state.greens ?? []) {
      if (manhattan(position, target.position) <= sensingRange) coveredGreenIds.push(target.id);
    }
    if (coveredGreenIds.length === 0) continue;
    const id = checkpointId(position, config);
    candidates.push({
      id,
      position,
      coveredGreenIds: coveredGreenIds.sort(),
      staticCoverageSize: coveredGreenIds.length
    });
  }

  shuffleInPlace(candidates);
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
      if (uncoveredGain === bestGain && best && Math.random() < 0.5) {
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
  const stalenessWeight = asNumber(config.unifiedScoutStalenessWeight, 1);
  const distanceWeight = asNumber(config.unifiedScoutDistanceWeight, 0.5);
  const topK = Math.max(1, Math.round(asNumber(config.unifiedScoutTopKForRedTieBreak, 5)));
  const startSearch = profile.hasUniformCosts ? bfsAllDistancesFrom(state, state.me.position) : null;
  const greenById = new Map((state.greens ?? []).map((green) => [green.id, green]));
  const candidates = [];

  for (const checkpoint of checkpoints) {
    const position = copyPosition(checkpoint.position);
    const edge = startSearch
      ? pathFromBfsAll(startSearch, position)
      : shortestGridPath(state, start, position, profile);
    if (!Number.isFinite(edge.cost) || edge.path.length <= 1) continue;

    let stalenessComponent = 0;
    let multiplierComponent = 0;
    let coveredGreenCount = 0;
    for (const greenId of checkpoint.coveredGreenIds ?? []) {
      const green = greenById.get(greenId);
      if (!green) continue;
      const observedAt = state.lastObservedAtByGreen?.[positionKey(green.position)];
      const Staleness = 
        observedAt === undefined ? Math.log(Math.max(1, asNumber(state.time, 0))) : Math.log(Math.max(1, asNumber(state.time, 0) - asNumber(observedAt, 0)));
      const multiplier = pickupMultiplierAt(state, green.position);
      multiplierComponent += multiplier;
      stalenessComponent += multiplier * stalenessWeight * Staleness;
      coveredGreenCount += 1;
    }
    if (coveredGreenCount === 0) continue;

    const checkpointValue = multiplierComponent + stalenessComponent;
    const redInfo = returnToRedPenalty(state, position, config);
    if (redInfo.trapPenaltyApplied) continue;
    const sector = sectorIdFor(position, config);
    const repeatPenalty = unifiedScoutRepeatPenalty(state, checkpoint.id, sector, config);
    const primaryScore = checkpointValue - distanceWeight * edge.cost - repeatPenalty;

    candidates.push({
      checkpoint,
      position,
      edge,
      checkpointValue,
      stalenessComponent,
      multiplierComponent,
      coveredGreenCount,
      repeatPenalty,
      distanceToNearestRed: redInfo.distanceToNearestRed,
      primaryScore
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.primaryScore - a.primaryScore || a.edge.cost - b.edge.cost || a.checkpoint.id.localeCompare(b.checkpoint.id));
  const top = candidates.slice(0, topK);
  top.sort(
    (a, b) =>
      a.distanceToNearestRed - b.distanceToNearestRed ||
      a.edge.cost - b.edge.cost ||
      a.checkpoint.id.localeCompare(b.checkpoint.id)
  );
  const best = top[0];

  return routePlanForScoutPoint({
    mode: "SCOUT_UNIFIED",
    state,
    profile,
    config,
    greenScores,
    pointId: best.checkpoint.id,
    point: best.position,
    edge: best.edge,
    value: best.primaryScore,
    scoutTarget: {
      id: best.checkpoint.id,
      position: copyPosition(best.position),
      score: best.primaryScore,
      primaryScore: best.primaryScore,
      checkpointValue: best.checkpointValue,
      stalenessComponent: best.stalenessComponent,
      multiplierComponent: best.multiplierComponent,
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

function previousExplorePosition(state) {
  if (state.lastPosition) return copyPosition(state.lastPosition);
  if (Array.isArray(state.recentPositions) && state.recentPositions.length > 0) {
    return copyPosition(state.recentPositions.at(-1));
  }
  return null;
}

function temporaryBlockScorePenalty(state, position) {
  const key = positionKey(position);
  const blocks = state.temporaryBlockedCells;
  if (!blocks) return 0;
  if (blocks instanceof Map) return blocks.has(key) ? 100 : 0;
  if (Array.isArray(blocks)) {
    return blocks.some((block) => positionKey(block.position ?? block) === key) ? 100 : 0;
  }
  return blocks[key] ? 100 : 0;
}

function enemyProximityPenalty(state, position, config) {
  let penalty = 0;
  for (const enemy of state.enemies ?? []) {
    const distance = manhattan(enemy.position, position);
    if (distance <= 1) penalty += asNumber(config.scoutCongestionPenalty, 10);
    else if (distance === 2) penalty += asNumber(config.scoutCongestionPenalty, 10) / 2;
  }
  return penalty;
}

function localExploreTieBreaker(state, position) {
  const seed = asNumber(state.time, 0) + position.x * 31 + position.y * 17;
  return (Math.abs(seed) % 4) * 1e-3;
}

export function buildLocalExplorePlan(state, profile, config) {
  const start = copyPosition(state.me.position);
  const previous = previousExplorePosition(state);
  const reverseKey = previous ? positionKey(previous) : null;
  const candidates = [];

  for (const position of [
    { x: start.x + 1, y: start.y },
    { x: start.x - 1, y: start.y },
    { x: start.x, y: start.y + 1 },
    { x: start.x, y: start.y - 1 }
  ]) {
    if (!isWalkable(state, position)) continue;
    const edge = shortestGridPath(state, start, position, profile);
    if (!Number.isFinite(edge.cost) || edge.path.length < 2) continue;
    const returnPenalty = returnToRedPenalty(state, position, config);

    const isReverse = reverseKey !== null && positionKey(position) === reverseKey;
    const score =
      asNumber(config.localExploreInfoWeight, 1) * tileInformationValue(state, position, config) +
      localExploreTieBreaker(state, position) -
      returnPenalty.penalty -
      (isReverse ? asNumber(config.localExploreReversePenalty, 20) : 0) -
      temporaryBlockScorePenalty(state, position) -
      enemyProximityPenalty(state, position, config);
    candidates.push({ position, edge, score, isReverse, returnPenalty });
  }

  candidates.sort((a, b) => b.score - a.score || Number(a.isReverse) - Number(b.isReverse));

  for (const candidate of candidates) {
    const { position, edge } = candidate;
    const startPoint = { id: "START", type: "start", position: start };
    const explorePoint = { id: "EXPLORE", type: "explore", position: copyPosition(position), noPickup: true };
    const oracle = {
      entries: new Map([
        [
          pairKey("START", "EXPLORE"),
          {
            fromId: "START",
            toId: "EXPLORE",
            cost: edge.cost,
            path: edge.path
          }
        ]
      ]),
      points: [startPoint, explorePoint],
      pointsById: new Map([
        ["START", startPoint],
        ["EXPLORE", explorePoint]
      ]),
      profile
    };

    return baseRoutePlan({
      mode: "LOCAL_EXPLORE",
      sequence: ["START", "EXPLORE"],
      path: edge.path.map(copyPosition),
      value: candidate.score,
      plan: initialPlan(state),
      profile,
      config,
      greenScores: {},
      candidateGreens: [],
      oracle,
      state
    });
  }

  return null;
}
