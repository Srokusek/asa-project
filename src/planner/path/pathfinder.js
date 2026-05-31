import {
  asNumber,
  copyPosition,
  getCell,
  isMoveAllowed,
  isWalkable,
  positionKey,
  buildMapProfile
} from "./grid-utils.js";

const EPSILON = 1e-9;

export function manhattanGridPath(from, to) {
  const path = [copyPosition(from)];
  let cursor = copyPosition(from);

  while (cursor.x !== to.x) {
    cursor = { x: cursor.x + Math.sign(to.x - cursor.x), y: cursor.y };
    path.push(copyPosition(cursor));
  }
  while (cursor.y !== to.y) {
    cursor = { x: cursor.x, y: cursor.y + Math.sign(to.y - cursor.y) };
    path.push(copyPosition(cursor));
  }

  return { cost: Math.max(0, path.length - 1), path };
}

export function getDirectedNeighbors(state, position) {
  return [
    { x: position.x + 1, y: position.y },
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y + 1 },
    { x: position.x, y: position.y - 1 }
  ].filter((next) => isMoveAllowed(state, position, next));
}

function incomingDirectedNeighbors(state, position) {
  return [
    { x: position.x + 1, y: position.y },
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y + 1 },
    { x: position.x, y: position.y - 1 }
  ].filter((previous) => isMoveAllowed(state, previous, position));
}

function minTraversalCost(state) {
  let minCost = Infinity;
  for (const row of state.grid) {
    for (const cell of row) {
      if (!cell.blocked) minCost = Math.min(minCost, asNumber(cell.cost, 1));
    }
  }
  return Number.isFinite(minCost) ? Math.max(EPSILON, minCost) : 1;
}

function reconstructPathFromParents(parent, start, goal) {
  const startKey = positionKey(start);
  const goalKey = positionKey(goal);
  if (startKey !== goalKey && !parent.has(goalKey)) return [];

  const path = [copyPosition(goal)];
  let cursor = goalKey;
  while (cursor !== startKey) {
    cursor = parent.get(cursor);
    if (!cursor) return [];
    const [x, y] = cursor.split(",").map(Number);
    path.push({ x, y });
  }
  path.reverse();
  return path;
}

export function bfsGridPath(state, from, to) {
  if (!isWalkable(state, from) || !isWalkable(state, to)) return { cost: Infinity, path: [] };
  if (positionKey(from) === positionKey(to)) return { cost: 0, path: [copyPosition(from)] };

  const queue = [copyPosition(from)];
  let head = 0;
  const visited = new Set([positionKey(from)]);
  const parent = new Map();

  while (head < queue.length) {
    const current = queue[head];
    head += 1;

    for (const next of getDirectedNeighbors(state, current)) {
      const key = positionKey(next);
      if (visited.has(key)) continue;
      visited.add(key);
      parent.set(key, positionKey(current));
      if (key === positionKey(to)) {
        const path = reconstructPathFromParents(parent, from, to);
        return { cost: path.length > 0 ? path.length - 1 : Infinity, path };
      }
      queue.push(next);
    }
  }

  return { cost: Infinity, path: [] };
}

export class PriorityQueue {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(value, priority) {
    const node = { value, priority };
    this.items.push(node);
    this._bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this._sinkDown(0);
    }
    return top.value;
  }

  _bubbleUp(index) {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.items[parent].priority <= this.items[cursor].priority) break;
      [this.items[parent], this.items[cursor]] = [this.items[cursor], this.items[parent]];
      cursor = parent;
    }
  }

  _sinkDown(index) {
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = cursor * 2 + 2;
      let smallest = cursor;

      if (left < this.items.length && this.items[left].priority < this.items[smallest].priority) {
        smallest = left;
      }
      if (right < this.items.length && this.items[right].priority < this.items[smallest].priority) {
        smallest = right;
      }
      if (smallest === cursor) break;
      [this.items[cursor], this.items[smallest]] = [this.items[smallest], this.items[cursor]];
      cursor = smallest;
    }
  }
}

function moveCostInto(state, position) {
  return asNumber(getCell(state, position)?.cost, 1);
}

function singleSourceDirectedDistances(state, sourcePosition) {
  const source = copyPosition(sourcePosition);
  const sourceKey = positionKey(source);
  const distanceByKey = new Map();

  if (!isWalkable(state, source)) return distanceByKey;

  const open = new PriorityQueue();
  distanceByKey.set(sourceKey, 0);
  open.push(source, 0);

  while (open.size > 0) {
    const current = open.pop();
    const currentKey = positionKey(current);
    const currentDistance = distanceByKey.get(currentKey);

    for (const next of getDirectedNeighbors(state, current)) {
      const nextKey = positionKey(next);
      const tentative = currentDistance + moveCostInto(state, next);
      if (tentative + EPSILON >= (distanceByKey.get(nextKey) ?? Infinity)) continue;
      distanceByKey.set(nextKey, tentative);
      open.push(next, tentative);
    }
  }

  return distanceByKey;
}

function multiSourceReverseDistancesToReds(state) {
  const distanceByKey = new Map();
  const nearestReachableRedByCell = new Map();
  if (!state.reds || state.reds.length === 0) {
    return { distanceByKey, nearestReachableRedByCell };
  }

  const open = new PriorityQueue();
  for (const red of state.reds) {
    if (!isWalkable(state, red.position)) continue;
    const key = positionKey(red.position);
    if ((distanceByKey.get(key) ?? Infinity) <= 0) continue;
    distanceByKey.set(key, 0);
    nearestReachableRedByCell.set(key, red);
    open.push(copyPosition(red.position), 0);
  }

  while (open.size > 0) {
    const current = open.pop();
    const currentKey = positionKey(current);
    const currentDistance = distanceByKey.get(currentKey);
    const sourceRed = nearestReachableRedByCell.get(currentKey);

    for (const previous of incomingDirectedNeighbors(state, current)) {
      const previousKey = positionKey(previous);
      const tentative = currentDistance + moveCostInto(state, current);
      if (tentative + EPSILON >= (distanceByKey.get(previousKey) ?? Infinity)) continue;
      distanceByKey.set(previousKey, tentative);
      nearestReachableRedByCell.set(previousKey, sourceRed);
      open.push(previous, tentative);
    }
  }

  return { distanceByKey, nearestReachableRedByCell };
}

export function buildDirectedDistanceFields(state) {
  const profile = state.__mapProfile ?? buildMapProfile(state);
  const distFromMe = singleSourceDirectedDistances(state, state.me.position);
  const reverse = multiSourceReverseDistancesToReds(state);

  return {
    distFromMe,
    distToNearestRed: reverse.distanceByKey,
    nearestReachableRedByCell: reverse.nearestReachableRedByCell,
    hasDirectionalTiles: Boolean(profile.hasDirectionalTiles)
  };
}

function directedDistanceFields(state) {
  return state.__directedDistanceFields ?? buildDirectedDistanceFields(state);
}

export function distanceFromMe(state, position) {
  const distance = directedDistanceFields(state).distFromMe.get(positionKey(position));
  return Number.isFinite(distance) ? distance : Infinity;
}

export function distanceToNearestReachableRed(state, position) {
  if (!state.reds || state.reds.length === 0) return 0;
  const distance = directedDistanceFields(state).distToNearestRed.get(positionKey(position));
  return Number.isFinite(distance) ? distance : Infinity;
}

export function reachableRedFromPosition(state, position) {
  return directedDistanceFields(state).nearestReachableRedByCell.get(positionKey(position)) ?? null;
}

export function aStarGridPath(state, from, to) {
  if (!isWalkable(state, from) || !isWalkable(state, to)) return { cost: Infinity, path: [] };
  if (positionKey(from) === positionKey(to)) return { cost: 0, path: [copyPosition(from)] };

  const open = new PriorityQueue();
  const startKey = positionKey(from);
  const goalKey = positionKey(to);
  const gScore = new Map([[startKey, 0]]);
  const parent = new Map();
  const heuristicScale = minTraversalCost(state);
  open.push(copyPosition(from), manhattan(from, to) * heuristicScale);

  while (open.size > 0) {
    const current = open.pop();
    const currentKey = positionKey(current);
    if (currentKey === goalKey) {
      const path = reconstructPathFromParents(parent, from, to);
      return { cost: gScore.get(goalKey) ?? Infinity, path };
    }

    for (const next of getDirectedNeighbors(state, current)) {
      const nextCell = getCell(state, next);
      const tentative = (gScore.get(currentKey) ?? Infinity) + asNumber(nextCell?.cost, 1);
      const nextKey = positionKey(next);
      if (tentative + EPSILON >= (gScore.get(nextKey) ?? Infinity)) continue;
      parent.set(nextKey, currentKey);
      gScore.set(nextKey, tentative);
      open.push(next, tentative + manhattan(next, to) * heuristicScale);
    }
  }

  return { cost: Infinity, path: [] };
}

function pathIsWalkable(state, path) {
  if (!Array.isArray(path) || !path.every((position) => isWalkable(state, position))) return false;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!isMoveAllowed(state, path[i], path[i + 1])) return false;
  }
  return true;
}

function manhattan(a, b) {
  return Math.abs(Math.round(a.x) - Math.round(b.x)) + Math.abs(Math.round(a.y) - Math.round(b.y));
}

export function shortestGridPath(state, from, to, profile = null) {
  // if the path between from and to is not walkable, return empty path and infinity cost
  if (!isWalkable(state, from) || !isWalkable(state, to)) return { cost: Infinity, path: [] };
  const mapProfile = profile ?? buildMapProfile(state);

  if (!mapProfile.hasObstacles && !mapProfile.hasDirectionalTiles && mapProfile.hasUniformCosts) {
    const direct = manhattanGridPath(from, to);
    if (pathIsWalkable(state, direct.path)) return direct;
    return bfsGridPath(state, from, to);
  }

  if (mapProfile.hasUniformCosts) return bfsGridPath(state, from, to);
  return aStarGridPath(state, from, to);
}

export function bfsAllDistancesFrom(state, sourcePosition) {
  const source = copyPosition(sourcePosition);
  const sourceKey = positionKey(source);
  const distanceByKey = new Map();
  const parentByKey = new Map();

  if (!isWalkable(state, source)) {
    return { source, distanceByKey, parentByKey };
  }

  const queue = [source];
  let head = 0;
  distanceByKey.set(sourceKey, 0);

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const currentKey = positionKey(current);
    const currentDistance = distanceByKey.get(currentKey) ?? 0;

    for (const next of getDirectedNeighbors(state, current)) {
      const nextKey = positionKey(next);
      if (distanceByKey.has(nextKey)) continue;
      distanceByKey.set(nextKey, currentDistance + 1);
      parentByKey.set(nextKey, currentKey);
      queue.push(next);
    }
  }

  return { source, distanceByKey, parentByKey };
}

export function pathFromBfsAll(result, targetPosition) {
  const target = copyPosition(targetPosition);
  const targetKey = positionKey(target);
  const sourceKey = positionKey(result.source);
  const cost = result.distanceByKey.get(targetKey);
  if (!Number.isFinite(cost)) return { cost: Infinity, path: [] };
  if (targetKey === sourceKey) return { cost: 0, path: [copyPosition(result.source)] };

  const path = [target];
  let cursor = targetKey;
  while (cursor !== sourceKey) {
    cursor = result.parentByKey.get(cursor);
    if (!cursor) return { cost: Infinity, path: [] };
    const [x, y] = cursor.split(",").map(Number);
    path.push({ x, y });
  }
  path.reverse();
  return { cost, path };
}
