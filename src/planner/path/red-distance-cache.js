import { asNumber, buildMapProfile, copyPosition, getCell, inBounds, isWalkable, positionKey } from "./grid-utils.js";
import { PriorityQueue } from "./pathfinder.js";

const EPSILON = 1e-9;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const MAX_TOPOLOGY_CACHE_SIZE = 12;

const RED_DISTANCE_CACHE = new Map();

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

export function staticTopologyKey(state) {
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

function staticMoveAllowed(state, from, to) {
  if (!inBounds(state, from) || !inBounds(state, to)) return false;
  const fromCell = getCell(state, from);
  const toCell = getCell(state, to);
  if (!fromCell || fromCell.blocked || !toCell || toCell.blocked) return false;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return false;

  let direction = null;
  if (dx === 1) direction = "right";
  else if (dx === -1) direction = "left";
  else if (dy === 1) direction = "up";
  else if (dy === -1) direction = "down";
  if (!direction) return false;

  if (fromCell.directionConstraint && fromCell.directionConstraint !== direction) return false;
  if (toCell.entryConstraint && toCell.entryConstraint !== direction) return false;
  return true;
}

function incomingDirectedNeighbors(state, position) {
  return [
    { x: position.x + 1, y: position.y },
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y + 1 },
    { x: position.x, y: position.y - 1 }
  ].filter((previous) => staticMoveAllowed(state, previous, position));
}

function moveCostInto(state, position) {
  return asNumber(getCell(state, position)?.cost, 1);
}

function reverseDistancesToRed(state, red) {
  const distanceByKey = new Map();
  const source = copyPosition(red.position);
  if (!isWalkable(state, source)) return distanceByKey;

  const open = new PriorityQueue();
  const sourceKey = positionKey(source);
  distanceByKey.set(sourceKey, 0);
  open.push(source, 0);

  while (open.size > 0) {
    const current = open.pop();
    const currentKey = positionKey(current);
    const currentDistance = distanceByKey.get(currentKey);

    for (const previous of incomingDirectedNeighbors(state, current)) {
      const previousKey = positionKey(previous);
      const tentative = currentDistance + moveCostInto(state, current);
      if (tentative + EPSILON >= (distanceByKey.get(previousKey) ?? Infinity)) continue;
      distanceByKey.set(previousKey, tentative);
      open.push(previous, tentative);
    }
  }

  return distanceByKey;
}

function buildForTopology(state, topologyKey) {
  const startedAt = Date.now();
  const distanceByRedId = new Map();
  for (const red of state.reds ?? []) {
    distanceByRedId.set(String(red.id), reverseDistancesToRed(state, red));
  }

  return {
    topologyKey,
    distanceByRedId,
    buildMs: Date.now() - startedAt,
    redCount: (state.reds ?? []).length,
    hasDirectionalTiles: Boolean((state.__mapProfile ?? buildMapProfile(state)).hasDirectionalTiles)
  };
}

export function getRedDistanceCacheForState(state) {
  const topologyKey = staticTopologyKey(state);
  const cached = RED_DISTANCE_CACHE.get(topologyKey);
  if (cached) {
    RED_DISTANCE_CACHE.delete(topologyKey);
    RED_DISTANCE_CACHE.set(topologyKey, cached);
    return {
      index: cached,
      cacheHit: true,
      buildMs: 0,
      topologyKey
    };
  }

  const built = buildForTopology(state, topologyKey);
  RED_DISTANCE_CACHE.set(topologyKey, built);
  if (RED_DISTANCE_CACHE.size > MAX_TOPOLOGY_CACHE_SIZE) {
    const oldest = RED_DISTANCE_CACHE.keys().next().value;
    RED_DISTANCE_CACHE.delete(oldest);
  }

  return {
    index: built,
    cacheHit: false,
    buildMs: built.buildMs,
    topologyKey
  };
}

export function distanceFromAnyTileToRed(cacheIndex, sourcePosition, redId) {
  if (!cacheIndex || !sourcePosition || !redId) return Infinity;
  const map = cacheIndex.distanceByRedId?.get(String(redId));
  if (!map) return Infinity;
  const distance = map.get(positionKey(sourcePosition));
  return Number.isFinite(distance) ? distance : Infinity;
}

export function __resetRedDistanceCacheForTests() {
  RED_DISTANCE_CACHE.clear();
}
