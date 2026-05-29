import { manhattan } from "../../utils/geometry.js";
import { DEFAULT_PARAMS } from "../default-params.js";
import { baseRoutePlan } from "../route-plan.js";
import { initialPlan } from "../search/plan-search.js";
import { asNumber, copyPosition, edgeKey, getCell, isWalkable, positionKey } from "../path/grid-utils.js";
import {
  bfsAllDistancesFrom,
  distanceFromMe,
  distanceToNearestReachableRed,
  getDirectedNeighbors,
  pathFromBfsAll,
  shortestGridPath
} from "../path/pathfinder.js";
import { hasAvailablePackage, packageConfidence, packageReward } from "../scoring/green-scorer.js";

const EPSILON = 1e-9;

function pairKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

export function visibleCellsFromPosition(state, position, range) {
  const center = copyPosition(position);
  const sensingRange = Math.max(0, asNumber(range, state.sensingRange ?? DEFAULT_PARAMS.sensingRange));
  const visible = [];

  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      if (manhattan(center, { x, y }) <= sensingRange) {
        visible.push({ x, y });
      }
    }
  }

  return visible;
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

export function informationValueAtWaypoint(state, waypoint, config) {
  const visible = visibleCellsFromPosition(state, waypoint, config.sensingRange);
  return visible.reduce((sum, position) => sum + tileInformationValue(state, position, config), 0);
}

function observedTimeForGreen(state, green) {
  return asNumber(state.lastObservedAtByGreen?.[positionKey(green.position)], NaN);
}

export function buildGreenClusters(state, config) {
  const greens = [...state.greens];
  const visited = new Set();
  const clusters = [];
  const distance = Math.max(0, asNumber(config.greenClusterDistance, 0));

  for (let i = 0; i < greens.length; i += 1) {
    if (visited.has(greens[i].id)) continue;

    const queue = [greens[i]];
    const members = [];
    visited.add(greens[i].id);

    while (queue.length > 0) {
      const current = queue.shift();
      members.push(current);

      for (const candidate of greens) {
        if (visited.has(candidate.id)) continue;
        if (members.some((member) => manhattan(member.position, candidate.position) <= distance)) {
          visited.add(candidate.id);
          queue.push(candidate);
        }
      }
    }

    const positions = members.map((green) => copyPosition(green.position));
    const centroid = {
      x: Math.round(positions.reduce((sum, position) => sum + position.x, 0) / positions.length),
      y: Math.round(positions.reduce((sum, position) => sum + position.y, 0) / positions.length)
    };
    const observedTimes = members
      .map((green) => observedTimeForGreen(state, green))
      .filter((time) => Number.isFinite(time));
    const lastObservedAt = observedTimes.length > 0 ? Math.max(...observedTimes) : null;
    const staleValues = members.map((green) => {
      const observed = observedTimeForGreen(state, green);
      if (!Number.isFinite(observed)) return config.maxStalenessValue;
      return Math.min(config.maxStalenessValue, Math.max(0, asNumber(state.time, 0) - observed));
    });
    const averageStaleness = staleValues.reduce((sum, value) => sum + value, 0) / Math.max(1, staleValues.length);
    const maxStaleness = Math.max(...staleValues);
    const id =
      members.length === 1
        ? members[0].id
        : members.length > 20
          ? `CLUSTER_size_${members.length}_centroid_${centroid.x}_${centroid.y}`
          : `CLUSTER_${members.map((green) => green.id).sort().join("_")}`;

    clusters.push({
      id,
      greenIds: members.map((green) => green.id),
      greens: members,
      positions,
      centroid,
      size: members.length,
      lastObservedAt,
      averageStaleness,
      maxStaleness,
      staleness:
        lastObservedAt === null
          ? config.maxStalenessValue
          : Math.min(config.maxStalenessValue, Math.max(0, asNumber(state.time, 0) - lastObservedAt))
    });
  }

  return clusters;
}

function clusterWaypoints(state, cluster, config) {
  const candidates = new Map();
  const add = (position, reason) => {
    const candidate = copyPosition(position);
    if (!isWalkable(state, candidate)) return;
    const key = positionKey(candidate);
    if (!candidates.has(key)) {
      candidates.set(key, { position: candidate, reasons: new Set() });
    }
    candidates.get(key).reasons.add(reason);
  };

  add(cluster.centroid, "centroid");
  for (const position of cluster.positions) {
    add(position, "green");
    for (const next of [
      { x: position.x + 1, y: position.y },
      { x: position.x - 1, y: position.y },
      { x: position.x, y: position.y + 1 },
      { x: position.x, y: position.y - 1 }
    ]) {
      add(next, "near_green");
    }
  }

  const range = Math.max(0, asNumber(config.sensingRange, 0));
  for (const greenPosition of cluster.positions) {
    for (let y = Math.max(0, greenPosition.y - range); y <= Math.min(state.height - 1, greenPosition.y + range); y += 1) {
      for (let x = Math.max(0, greenPosition.x - range); x <= Math.min(state.width - 1, greenPosition.x + range); x += 1) {
        const position = { x, y };
        if (manhattan(position, greenPosition) <= range) add(position, "vision");
      }
    }
  }

  return [...candidates.values()].map((candidate) => ({
    position: candidate.position,
    reasons: [...candidate.reasons]
  }));
}

export function visibleAvailablePackages(state, config) {
  return state.greens.filter((green) => {
    if (!hasAvailablePackage(green, config)) return false;
    const lastSeen = asNumber(green.package?.lastSeenTime, NaN);
    return packageConfidence(green) >= 1 || lastSeen >= asNumber(state.time, 0);
  });
}

function greenStalenessAt(state, position, config) {
  const key = positionKey(position);
  const last = state.lastObservedAtByGreen?.[key] ?? state.lastObservedAtByTile?.[key];
  if (last === undefined) return config.maxStalenessValue;
  return Math.min(config.maxStalenessValue, Math.max(0, asNumber(state.time, 0) - asNumber(last, 0)));
}

function exposureStatsAt(state, position, config) {
  const visible = visibleCellsFromPosition(state, position, config.sensingRange);
  let greenVisibleAfterPath = 0;
  let staleGreenVisibleAfterPath = 0;
  let newTilesVisibleAfterPath = 0;
  let localInformationValue = 0;

  for (const cellPosition of visible) {
    const cell = getCell(state, cellPosition);
    if (!cell || cell.blocked) continue;
    const key = positionKey(cellPosition);
    if (state.lastObservedAtByTile?.[key] === undefined) newTilesVisibleAfterPath += 1;
    if (cell.type === "green") {
      greenVisibleAfterPath += 1;
      if (greenStalenessAt(state, cellPosition, config) > 0) staleGreenVisibleAfterPath += 1;
    }
    localInformationValue += tileInformationValue(state, cellPosition, config);
  }

  return {
    localInformationValue,
    staleGreenCoverage: staleGreenVisibleAfterPath,
    newTileCoverage: newTilesVisibleAfterPath,
    greenVisibleAfterPath,
    staleGreenVisibleAfterPath,
    newTilesVisibleAfterPath
  };
}

function enemyRiskAt(state, position, distance = 1, penalty = 10) {
  return (state.enemies ?? []).some((enemy) => manhattan(enemy.position, position) <= distance) ? penalty : 0;
}

function returnToRedPenalty(state, position, config) {
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

function denseScoutWaypointCandidates(state, config) {
  const start = copyPosition(state.me.position);
  const radius = Math.max(1, asNumber(config.denseScoutRadius, DEFAULT_PARAMS.denseScoutRadius));
  const candidates = [];

  for (let y = Math.max(0, start.y - radius); y <= Math.min(state.height - 1, start.y + radius); y += 1) {
    for (let x = Math.max(0, start.x - radius); x <= Math.min(state.width - 1, start.x + radius); x += 1) {
      const position = { x, y };
      if (positionKey(position) === positionKey(start)) continue;
      if (manhattan(start, position) > radius) continue;
      if (!isWalkable(state, position)) continue;
      if (
        state.lastDeliveryPosition &&
        manhattan(state.lastDeliveryPosition, position) <
          asNumber(config.denseScoutMinDistanceFromLastDelivery, DEFAULT_PARAMS.denseScoutMinDistanceFromLastDelivery)
      ) {
        continue;
      }
      candidates.push(position);
    }
  }

  return candidates;
}

export function buildDenseGreenScoutPlan(state, profile, config, greenScores) {
  let best = null;
  const start = copyPosition(state.me.position);
  const candidates = denseScoutWaypointCandidates(state, config);
  const limited = candidates
    .sort((a, b) => distanceFromMe(state, a) - distanceFromMe(state, b))
    .slice(0, Math.max(1, asNumber(config.denseScoutMaxWaypoints, DEFAULT_PARAMS.denseScoutMaxWaypoints)) * 3);

  for (const position of limited) {
    const directedFromMe = distanceFromMe(state, position);
    if (!Number.isFinite(directedFromMe)) continue;
    const returnPenalty = returnToRedPenalty(state, position, config);
    if (returnPenalty.trapPenaltyApplied) continue;
    const edge = shortestGridPath(state, start, position, profile);
    if (!Number.isFinite(edge.cost) || edge.path.length <= 1) continue;
    const stats = exposureStatsAt(state, position, config);
    const recentlyVisitedPenalty =
      state.lastScoutTargetId === `DENSE_SCOUT_${position.x}_${position.y}` ? config.sameScoutTargetPenalty : 0;
    const enemyPenalty = enemyRiskAt(state, position, config.scoutCongestionDistance, config.scoutCongestionPenalty);
    const score =
      stats.localInformationValue +
      stats.staleGreenCoverage +
      stats.newTileCoverage -
      config.scoutDistanceWeight * directedFromMe -
      returnPenalty.penalty -
      recentlyVisitedPenalty -
      enemyPenalty;

    if (!best || score > best.score) {
      best = { position, edge, stats, score, directedFromMe, returnPenalty };
    }
  }

  if (!best) return null;

  const id = `DENSE_SCOUT_${best.position.x}_${best.position.y}`;
  return routePlanForScoutPoint({
    mode: "DENSE_SCOUT",
    state,
    profile,
    config,
    greenScores,
    pointId: id,
    point: best.position,
    edge: best.edge,
    value: best.score,
    scoutTarget: {
      id,
      position: copyPosition(best.position),
      localInformationValue: best.stats.localInformationValue,
      staleGreenCoverage: best.stats.staleGreenCoverage,
      newTileCoverage: best.stats.newTileCoverage,
      distanceFromMe: best.directedFromMe,
      distanceToNearestRed: best.returnPenalty.distanceToNearestRed,
      trapPenaltyApplied: best.returnPenalty.trapPenaltyApplied,
      score: best.score
    }
  });
}

function visitedTick(mapLike, key) {
  if (!mapLike) return undefined;
  if (mapLike instanceof Map) return mapLike.get(key);
  return mapLike[key];
}

function sectorIdFor(position, config) {
  const size = Math.max(1, asNumber(config.coverageSectorSize, DEFAULT_PARAMS.coverageSectorSize));
  return `${Math.floor(position.x / size)},${Math.floor(position.y / size)}`;
}

function pathNoveltyPenalty(state, path, config) {
  let repeatedPositions = 0;
  let repeatedEdges = 0;
  const now = asNumber(state.time, 0);
  const positionCooldown = asNumber(config.positionCooldownTicks, DEFAULT_PARAMS.positionCooldownTicks);
  const edgeCooldown = asNumber(config.edgeCooldownTicks, DEFAULT_PARAMS.edgeCooldownTicks);

  for (const position of path.slice(1)) {
    const last = asNumber(visitedTick(state.visitedPositions, positionKey(position)), -Infinity);
    if (Number.isFinite(last) && now - last <= positionCooldown) repeatedPositions += 1;
  }

  for (let i = 0; i < path.length - 1; i += 1) {
    const key = edgeKey(path[i], path[i + 1]);
    const last = asNumber(visitedTick(state.visitedEdges, key), -Infinity);
    if (Number.isFinite(last) && now - last <= edgeCooldown) repeatedEdges += 1;
  }

  return {
    repeatedPositions,
    repeatedEdges,
    penalty:
      repeatedPositions * asNumber(config.positionRevisitPenalty, DEFAULT_PARAMS.positionRevisitPenalty) +
      repeatedEdges * asNumber(config.edgeRevisitPenalty, DEFAULT_PARAMS.edgeRevisitPenalty)
  };
}

function scoutTargetAttemptPenalty(state, targetId, sectorId, config) {
  const now = asNumber(state.time, 0);
  const cooldown = asNumber(config.failedScoutTargetCooldownTicks, DEFAULT_PARAMS.failedScoutTargetCooldownTicks);
  const attempt = state.scoutTargetAttempts?.[targetId];
  const targetRecent = attempt && now - asNumber(attempt.lastAttemptTick, -Infinity) <= cooldown;
  const sectorRecent = (state.recentScoutTargets ?? []).some((id) => String(id).includes(`_${sectorId}`));
  return (
    (targetRecent ? asNumber(config.sameTargetPenalty, DEFAULT_PARAMS.sameTargetPenalty) : 0) +
    (sectorRecent ? asNumber(config.sameSectorPenalty, DEFAULT_PARAMS.sameSectorPenalty) : 0)
  );
}

function pathExposureScore(state, path, config, previousKey = null) {
  const end = path.at(-1);
  const stats = exposureStatsAt(state, end, config);
  const returnPenalty = returnToRedPenalty(state, end, config);
  const sectorId = sectorIdFor(end, config);
  const targetId = `GREEN_EXPOSURE_${end.x}_${end.y}`;
  const novelty = pathNoveltyPenalty(state, path, config);
  const repeatScoutPenalty = scoutTargetAttemptPenalty(state, targetId, sectorId, config);
  const firstMove = path[1] ?? null;
  const immediateBacktrackPenalty =
    previousKey && firstMove && positionKey(firstMove) === previousKey ? config.greenExposureBacktrackPenalty : 0;
  const enemyRisk = path.some((position) => enemyRiskAt(state, position, 1, 1)) ? config.scoutCongestionPenalty : 0;
  const score =
    stats.greenVisibleAfterPath * config.greenExposureGreenWeight +
    stats.staleGreenVisibleAfterPath * config.greenExposureStaleWeight +
    stats.newTilesVisibleAfterPath * config.greenExposureNewTileWeight -
    (path.length - 1) * config.greenExposureDistanceWeight -
    returnPenalty.penalty -
    novelty.penalty -
    repeatScoutPenalty -
    enemyRisk -
    immediateBacktrackPenalty;

  return { score, ...stats, ...returnPenalty, ...novelty, sectorId, targetId };
}

export function buildGreenExposureScoutPlan(state, profile, config, greenScores) {
  const start = copyPosition(state.me.position);
  const previous = previousExplorePosition(state);
  const previousKey = previous ? positionKey(previous) : null;
  let beam = [{ path: [start], visited: new Set([positionKey(start)]) }];
  let best = null;
  let bestShort = null;
  let expanded = 0;

  for (let depth = 0; depth < config.greenExposureDepth; depth += 1) {
    const nextBeam = [];
    for (const item of beam) {
      const current = item.path.at(-1);
      for (const next of getDirectedNeighbors(state, current)) {
        const key = positionKey(next);
        if (item.visited.has(key)) continue;
        const path = [...item.path, copyPosition(next)];
        const scored = pathExposureScore(state, path, config, previousKey);
        if (scored.trapPenaltyApplied) continue;
        const candidate = {
          path,
          visited: new Set([...item.visited, key]),
          ...scored
        };
        const moveCount = path.length - 1;
        if (moveCount >= config.greenExposureMinPlanLength) {
          if (!best || candidate.score > best.score || (Math.abs(candidate.score - best.score) <= EPSILON && candidate.repeatedEdges < best.repeatedEdges)) {
            best = candidate;
          }
        } else if (!bestShort || candidate.score > bestShort.score) {
          bestShort = candidate;
        }
        nextBeam.push(candidate);
        expanded += 1;
        if (expanded >= config.greenExposureMaxExpanded) break;
      }
      if (expanded >= config.greenExposureMaxExpanded) break;
    }
    if (nextBeam.length === 0 || expanded >= config.greenExposureMaxExpanded) break;
    nextBeam.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    beam = nextBeam.slice(0, config.greenExposureBeamWidth);
  }

  best = best ?? bestShort;
  if (!best || best.path.length <= 1) return null;
  if (best.score < asNumber(config.minGreenExposureScore, DEFAULT_PARAMS.minGreenExposureScore)) return null;

  const position = best.path.at(-1);
  const edge = { cost: best.path.length - 1, path: best.path };
  const id = `GREEN_EXPOSURE_${position.x}_${position.y}`;
  return routePlanForScoutPoint({
    mode: "GREEN_EXPOSURE_SCOUT",
    state,
    profile,
    config,
    greenScores,
    pointId: id,
    point: position,
    edge,
    value: best.score,
    scoutTarget: {
      id,
      position: copyPosition(position),
      score: best.score,
      distanceFromMe: best.path.length - 1,
      distanceToNearestRed: best.distanceToNearestRed,
      trapPenaltyApplied: best.trapPenaltyApplied,
      sectorId: best.sectorId,
      repeatedPositions: best.repeatedPositions,
      repeatedEdges: best.repeatedEdges,
      greenVisibleAfterPath: best.greenVisibleAfterPath,
      staleGreenVisibleAfterPath: best.staleGreenVisibleAfterPath,
      newTilesVisibleAfterPath: best.newTilesVisibleAfterPath
    }
  });
}

export function buildScoutPlan(state, profile, config, greenScores) {
  let best = null;
  const startSearch = profile.hasUniformCosts ? bfsAllDistancesFrom(state, state.me.position) : null;
  const clusters = buildGreenClusters(state, config);

  for (const cluster of clusters) {
    for (const waypoint of clusterWaypoints(state, cluster, config)) {
      const directedFromMe = distanceFromMe(state, waypoint.position);
      if (!Number.isFinite(directedFromMe)) continue;
      const returnPenalty = returnToRedPenalty(state, waypoint.position, config);
      if (returnPenalty.trapPenaltyApplied) continue;
      const edge = startSearch
        ? pathFromBfsAll(startSearch, waypoint.position)
        : shortestGridPath(state, state.me.position, waypoint.position, profile);
      if (!Number.isFinite(edge.cost) || edge.path.length === 0) continue;
      if (edge.cost === 0) continue;

      const futureScore =
        cluster.greens.reduce((sum, green) => sum + (greenScores.get(green.id) ?? 0), 0) * config.emptyGreenFutureWeight;
      const infoValue = informationValueAtWaypoint(state, waypoint.position, config);
      const redDistance = returnPenalty.distanceToNearestRed;
      const redPenalty = returnPenalty.penalty;
      const lastVisited = asNumber(state.visitedGreenAt?.[cluster.id], -Infinity);
      const recentlyVisited =
        Number.isFinite(lastVisited) && asNumber(state.time, 0) - lastVisited < config.scoutCooldownTicks;
      const recentlyObserved = cluster.staleness < config.scoutCooldownTicks;
      const recentlyVisitedPenalty = recentlyVisited || recentlyObserved ? config.recentScoutPenalty : 0;
      const sameTargetPenalty =
        state.lastScoutTargetId === cluster.id || state.lastScoutTargetId === `SCOUT_${cluster.id}`
          ? config.sameScoutTargetPenalty
          : 0;
      const congestionPenalty = (state.enemies ?? []).some(
        (enemy) =>
          manhattan(enemy.position, waypoint.position) <= config.scoutCongestionDistance ||
          cluster.positions.some((position) => manhattan(enemy.position, position) <= config.scoutCongestionDistance)
      )
        ? config.scoutCongestionPenalty
        : 0;
      const debtBonus =
        cluster.staleness > config.explorationDebtThreshold ? config.explorationDebtBonus : 0;
      const noveltyBonus = recentlyVisited || recentlyObserved ? 0 : config.noveltyBonus;
      const clusterBonus = cluster.size * config.clusterSizeWeight;
      const scoutScore =
        config.infoValueWeight * infoValue +
        config.scoutFutureWeight * futureScore +
        clusterBonus +
        debtBonus +
        noveltyBonus -
        config.scoutDistanceWeight * directedFromMe -
        redPenalty -
        recentlyVisitedPenalty -
        sameTargetPenalty -
        congestionPenalty;

      if (!best || scoutScore > best.scoutScore) {
        best = {
          cluster,
          waypoint,
          edge,
          scoutScore,
          infoValue,
          redDistance,
          redPenalty,
          directedFromMe,
          trapPenaltyApplied: returnPenalty.trapPenaltyApplied,
          clusterBonus,
          debtBonus,
          congestionPenalty,
          recentlyVisitedPenalty,
          sameTargetPenalty
        };
      }
    }
  }

  if (!best) return null;

  const startPoint = { id: "START", type: "start", position: copyPosition(state.me.position) };
  const scoutPoint = {
    id: `SCOUT_${best.cluster.id}`,
    type: "scout",
    position: copyPosition(best.waypoint.position),
    sourceGreenId: best.cluster.greenIds[0],
    clusterId: best.cluster.id,
    noPickup: true
  };
  const oracle = {
    entries: new Map([
      [
        pairKey("START", scoutPoint.id),
        {
          fromId: "START",
          toId: scoutPoint.id,
          cost: best.edge.cost,
          path: best.edge.path
        }
      ]
    ]),
    points: [startPoint, scoutPoint],
    pointsById: new Map([
      ["START", startPoint],
      [scoutPoint.id, scoutPoint]
    ]),
    profile
  };

  return baseRoutePlan({
    mode: "SCOUT",
    sequence: ["START", scoutPoint.id],
    path: best.edge.path.map(copyPosition),
    value: best.scoutScore,
    plan: initialPlan(state),
    profile,
    config,
    greenScores,
    candidateGreens: [],
    scoutTarget: {
      id: best.cluster.id,
      type: "cluster",
      greenIds: best.cluster.greenIds,
      positions: best.cluster.positions,
      centroid: best.cluster.centroid,
      size: best.cluster.size,
      lastObservedAt: best.cluster.lastObservedAt,
      averageStaleness: best.cluster.averageStaleness,
      maxStaleness: best.cluster.maxStaleness,
      staleness: best.cluster.staleness,
      position: copyPosition(best.waypoint.position),
      waypointReasons: best.waypoint.reasons,
      infoValue: best.infoValue,
      scoutScore: best.scoutScore,
      redDistance: best.redDistance,
      distanceFromMe: best.directedFromMe,
      distanceToNearestRed: best.redDistance,
      trapPenaltyApplied: best.trapPenaltyApplied,
      redPenalty: best.redPenalty,
      clusterBonus: best.clusterBonus,
      debtBonus: best.debtBonus,
      congestionPenalty: best.congestionPenalty,
      recentlyVisitedPenalty: best.recentlyVisitedPenalty,
      sameTargetPenalty: best.sameTargetPenalty
    },
    oracle,
    state
  });
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
