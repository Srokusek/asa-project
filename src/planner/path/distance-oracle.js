import { directionFromPositions } from "../../utils/geometry.js";
import { asNumber, buildMapProfile, copyPosition, getCell, inBounds, isMoveAllowed, isWalkable, positionKey } from "./grid-utils.js";
import { PriorityQueue, shortestGridPath } from "./pathfinder.js";

const EPSILON = 1e-9;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

let STATIC_POI_INDEX = null;
let STATIC_POI_INDEX_VERSION = 0;

function pairKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

function fnvMixByte(hash, byte) {
  return Math.imul(hash ^ (byte & 0xff), FNV_PRIME) >>> 0;
}

function fnvMixString(hash, value) {
  const text = String(value ?? "");
  let mixed = hash >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    mixed = fnvMixByte(mixed, text.charCodeAt(i));
  }
  return mixed >>> 0;
}

function fnvMixNumber(hash, value) {
  return fnvMixString(hash, Number(value) || 0);
}

function staticTopologyKey(state) {
  let hash = FNV_OFFSET_BASIS;
  hash = fnvMixNumber(hash, state.width);
  hash = fnvMixNumber(hash, state.height);

  for (const row of state.grid) {
    for (const cell of row) {
      hash = fnvMixByte(hash, cell.blocked ? 1 : 0);
      hash = fnvMixNumber(hash, Math.round(asNumber(cell.cost, 1) * 1000));
      hash = fnvMixString(hash, cell.directionConstraint ?? "");
      hash = fnvMixString(hash, cell.entryConstraint ?? "");
    }
  }

  return `topo_${state.width}x${state.height}_${hash >>> 0}`;
}

function collectStaticPoiSources(state) {
  const greens = (state.greens ?? [])
    .filter((green) => !String(green.id ?? "").startsWith("P_"))
    .map((green) => ({
      id: String(green.id),
      type: "green",
      position: copyPosition(green.position)
    }));
  const reds = (state.reds ?? []).map((red) => ({
    id: String(red.id),
    type: "red",
    position: copyPosition(red.position)
  }));
  return [...greens, ...reds].sort((a, b) => a.id.localeCompare(b.id));
}

function poiSourcesKey(sources) {
  return sources.map((source) => `${source.id}:${source.type}@${positionKey(source.position)}`).join("|");
}

function staticMoveAllowed(state, from, to) {
  if (!inBounds(state, from) || !inBounds(state, to)) return false;
  const fromCell = getCell(state, from);
  const toCell = getCell(state, to);
  if (!fromCell || fromCell.blocked || !toCell || toCell.blocked) return false;
  const direction = directionFromPositions(from, to);
  if (!direction) return false;
  if (fromCell.directionConstraint && fromCell.directionConstraint !== direction) return false;
  if (toCell.entryConstraint && toCell.entryConstraint !== direction) return false;
  return true;
}

function staticNeighbors(state, position) {
  return [
    { x: position.x + 1, y: position.y },
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y + 1 },
    { x: position.x, y: position.y - 1 }
  ].filter((next) => staticMoveAllowed(state, position, next));
}

function buildStaticShortestTree(state, sourcePosition) {
  const source = copyPosition(sourcePosition);
  const sourceKey = positionKey(source);
  const distanceByKey = new Map();
  const parentByKey = new Map();

  if (!inBounds(state, source)) return { source, distanceByKey, parentByKey };
  const sourceCell = getCell(state, source);
  if (!sourceCell || sourceCell.blocked) return { source, distanceByKey, parentByKey };

  const open = new PriorityQueue();
  distanceByKey.set(sourceKey, 0);
  open.push({ position: source, distance: 0 }, 0);

  while (open.size > 0) {
    const current = open.pop();
    const currentPosition = current.position;
    const currentKey = positionKey(currentPosition);
    const currentDistance = distanceByKey.get(currentKey);
    if (!Number.isFinite(currentDistance)) continue;
    if (current.distance > currentDistance + EPSILON) continue;

    for (const next of staticNeighbors(state, currentPosition)) {
      const nextKey = positionKey(next);
      const tentative = currentDistance + asNumber(getCell(state, next)?.cost, 1);
      if (tentative + EPSILON >= (distanceByKey.get(nextKey) ?? Infinity)) continue;
      distanceByKey.set(nextKey, tentative);
      parentByKey.set(nextKey, currentKey);
      open.push({ position: copyPosition(next), distance: tentative }, tentative);
    }
  }

  return { source, distanceByKey, parentByKey };
}

function reconstructPathFromTree(tree, targetPosition) {
  const sourceKey = positionKey(tree.source);
  const target = copyPosition(targetPosition);
  const targetKey = positionKey(target);
  if (targetKey === sourceKey) return [copyPosition(tree.source)];
  if (!Number.isFinite(tree.distanceByKey.get(targetKey))) return [];

  const path = [target];
  let cursor = targetKey;
  while (cursor !== sourceKey) {
    const parent = tree.parentByKey.get(cursor);
    if (!parent) return [];
    const [x, y] = parent.split(",").map(Number);
    path.push({ x, y });
    cursor = parent;
  }
  path.reverse();
  return path;
}

function buildStaticPoiIndex(state, profile, sources, topologyKey) {
  const startedAt = Date.now();
  const treesBySourceId = new Map();
  for (const source of sources) {
    treesBySourceId.set(source.id, buildStaticShortestTree(state, source.position));
  }

  return {
    version: ++STATIC_POI_INDEX_VERSION,
    staticTopologyKey: topologyKey,
    sourceSetKey: poiSourcesKey(sources),
    sources,
    profile,
    treesBySourceId,
    buildMs: Date.now() - startedAt
  };
}

function ensureStaticPoiIndex(state, profile) {
  const topologyKey = staticTopologyKey(state);
  const sources = collectStaticPoiSources(state);
  const sourceSetKey = poiSourcesKey(sources);
  const shouldReuse =
    STATIC_POI_INDEX &&
    STATIC_POI_INDEX.staticTopologyKey === topologyKey &&
    STATIC_POI_INDEX.sourceSetKey === sourceSetKey;

  if (shouldReuse) {
    return { index: STATIC_POI_INDEX, staticIndexBuildMs: 0, staticIndexReuseCount: 1 };
  }

  STATIC_POI_INDEX = buildStaticPoiIndex(state, profile, sources, topologyKey);
  return { index: STATIC_POI_INDEX, staticIndexBuildMs: STATIC_POI_INDEX.buildMs, staticIndexReuseCount: 0 };
}

function walkablePathInCurrentState(state, path) {
  if (!Array.isArray(path) || path.length === 0) return false;
  if (!path.every((position) => isWalkable(state, position))) return false;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!isMoveAllowed(state, path[i], path[i + 1])) return false;
  }
  return true;
}

function resolveStartCost(oracle, toPoint) {
  const directed = oracle.state.__directedDistanceFields?.distFromMe;
  if (directed) {
    const cached = directed.get(positionKey(toPoint.position));
    if (Number.isFinite(cached)) return cached;
  }

  oracle.stats.pathfindingCalls += 1;
  const fallback = shortestGridPath(
    oracle.state,
    oracle.pointsById.get("START")?.position ?? oracle.state.me.position,
    toPoint.position,
    oracle.profile
  );
  if (Array.isArray(fallback.path) && fallback.path.length > 0) {
    oracle.stats.pathComputes += 1;
  }
  return fallback.cost;
}

function resolveStaticPoiCost(oracle, fromPoint, toPoint) {
  const tree = oracle.staticIndex?.treesBySourceId.get(fromPoint.id);
  if (!tree) return null;
  oracle.stats.costCacheHits += 1;
  return tree.distanceByKey.get(positionKey(toPoint.position)) ?? Infinity;
}

function resolveFallbackCost(oracle, fromPoint, toPoint) {
  oracle.stats.pathfindingCalls += 1;
  const edge = shortestGridPath(oracle.state, fromPoint.position, toPoint.position, oracle.profile);
  if (Array.isArray(edge.path) && edge.path.length > 0) {
    oracle.stats.pathComputes += 1;
  }
  return edge.cost;
}

function resolveEdgeCost(oracle, fromPoint, toPoint) {
  if (fromPoint.id === "START") return resolveStartCost(oracle, toPoint);
  const staticCost = resolveStaticPoiCost(oracle, fromPoint, toPoint);
  if (staticCost !== null) return staticCost;
  return resolveFallbackCost(oracle, fromPoint, toPoint);
}

function resolveStaticPoiPath(oracle, fromPoint, toPoint) {
  const tree = oracle.staticIndex?.treesBySourceId.get(fromPoint.id);
  if (!tree) return [];
  oracle.stats.pathComputes += 1;
  return reconstructPathFromTree(tree, toPoint.position);
}

function resolveStartPath(oracle, toPoint) {
  oracle.stats.pathfindingCalls += 1;
  oracle.stats.pathComputes += 1;
  return shortestGridPath(
    oracle.state,
    oracle.pointsById.get("START")?.position ?? oracle.state.me.position,
    toPoint.position,
    oracle.profile
  ).path;
}

function resolveFallbackPath(oracle, fromPoint, toPoint) {
  oracle.stats.pathfindingCalls += 1;
  oracle.stats.pathComputes += 1;
  return shortestGridPath(oracle.state, fromPoint.position, toPoint.position, oracle.profile).path;
}

function resolveEdgePath(oracle, fromPoint, toPoint) {
  if (fromPoint.id === "START") return resolveStartPath(oracle, toPoint);
  if (oracle.staticIndex?.treesBySourceId.has(fromPoint.id)) {
    return resolveStaticPoiPath(oracle, fromPoint, toPoint);
  }
  return resolveFallbackPath(oracle, fromPoint, toPoint);
}

export function buildDistanceOracle(state, points) {
  const profile = buildMapProfile(state);
  const entries = new Map();
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const staticIndexStatus = ensureStaticPoiIndex(state, profile);

  const stats = {
    points: points.length,
    pathfindingCalls: 0,
    singleSourceBfsRuns: 0,
    edgeRequests: 0,
    lazyEdgeComputes: 0,
    costCacheHits: 0,
    pathComputes: 0,
    staticIndexBuildMs: staticIndexStatus.staticIndexBuildMs,
    staticIndexReuseCount: staticIndexStatus.staticIndexReuseCount,
    startSingleSourceMs: asNumber(state.__startSingleSourceMs, 0),
    dynamicPathRepairs: 0,
    dynamicRepairFailReplans: 0
  };

  return {
    entries,
    points,
    pointsById,
    profile,
    state,
    stats,
    staticIndex: staticIndexStatus.index
  };
}

export function getOracleEdge(oracle, fromId, toId, options = {}) {
  const requirePath = Boolean(options.requirePath);
  if (!oracle || !fromId || !toId || fromId === toId) return null;
  const fromPoint = oracle.pointsById.get(fromId);
  const toPoint = oracle.pointsById.get(toId);
  if (!fromPoint || !toPoint) return null;

  oracle.stats.edgeRequests += 1;
  const key = pairKey(fromId, toId);
  let edge = oracle.entries.get(key);
  if (!edge) {
    const cost = resolveEdgeCost(oracle, fromPoint, toPoint);
    edge = {
      fromId,
      toId,
      cost,
      path: null
    };
    oracle.entries.set(key, edge);
    oracle.stats.lazyEdgeComputes += 1;
  }

  if (requirePath && !Array.isArray(edge.path)) {
    edge.path = resolveEdgePath(oracle, fromPoint, toPoint).map(copyPosition);
  }

  return edge;
}

export function reconstructGridPath(sequence, oracle) {
  if (!Array.isArray(sequence) || sequence.length === 0) return [];
  const startPoint = oracle.pointsById.get(sequence[0]);
  const fullPath = startPoint ? [copyPosition(startPoint.position)] : [];

  for (let i = 0; i < sequence.length - 1; i += 1) {
    const fromId = sequence[i];
    const toId = sequence[i + 1];
    const edge = getOracleEdge(oracle, fromId, toId, { requirePath: true });
    const targetPoint = oracle.pointsById.get(toId);
    if (!edge || !Number.isFinite(edge.cost) || !Array.isArray(edge.path) || edge.path.length === 0 || !targetPoint) {
      return [];
    }

    let segment = edge.path.map(copyPosition);
    if (!walkablePathInCurrentState(oracle.state, segment)) {
      oracle.stats.pathfindingCalls += 1;
      const repaired = shortestGridPath(oracle.state, segment[0], targetPoint.position, oracle.profile);
      if (
        !Number.isFinite(repaired.cost) ||
        !Array.isArray(repaired.path) ||
        repaired.path.length === 0 ||
        !walkablePathInCurrentState(oracle.state, repaired.path)
      ) {
        oracle.stats.dynamicRepairFailReplans += 1;
        return [];
      }
      oracle.stats.dynamicPathRepairs += 1;
      oracle.stats.pathComputes += 1;
      segment = repaired.path.map(copyPosition);
      edge.path = segment;
      edge.cost = repaired.cost;
    }

    const segmentToAppend = i === 0 && fullPath.length === 0 ? segment : segment.slice(1);
    fullPath.push(...segmentToAppend.map(copyPosition));
  }

  return fullPath;
}
