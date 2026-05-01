/**
 * Grid route planner for parcel pickup/deliveroo games.
 *
 * The planner searches only on a reduced graph of important points:
 * START + selected green cells + red delivery cells. Real grid paths are
 * computed between those points and cached in a distance oracle.
 */

const EPSILON = 1e-9;

export const DEFAULT_PARAMS = Object.freeze({
  meanPackageValue: 10,
  packageVariance: 0,
  decayRate: 0,
  generationMeanTime: null,
  generationProbability: null,
  maxPackages: Infinity,
  kSmoothMax: 0.25,
  kWin: 1,
  rhoGeneration: 0,
  moveWeight: 1,
  betaCarry: 0.5,
  periodicReplanTicks: 5,
  minParcelConfidence: 0.3,
  enemySafetyMargin: 0,
  maxPlanningTimeMs: 30
});

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positionKey(position) {
  return `${position.x},${position.y}`;
}

function pairKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

function mapToObject(map) {
  return map instanceof Map ? Object.fromEntries(map) : map ?? {};
}

function copyPosition(position) {
  return { x: Math.round(asNumber(position?.x)), y: Math.round(asNumber(position?.y)) };
}

function normalizeId(prefix, id, position) {
  if (id !== undefined && id !== null && String(id).length > 0) return String(id);
  return `${prefix}_${position.x}_${position.y}`;
}

function normalizeParams(params = {}) {
  return { ...DEFAULT_PARAMS, ...params };
}

function normalizeCell(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const normalized = normalizeCell(raw.type ?? raw.kind ?? raw.tile ?? "normal");
    const blocked = raw.blocked === true || raw.walkable === false || normalized.blocked;
    const cost = asNumber(raw.cost ?? raw.moveCost ?? normalized.cost, normalized.cost);
    return {
      type: blocked ? "wall" : normalized.type,
      rawType: raw.type ?? normalized.rawType,
      blocked,
      cost: blocked ? Infinity : Math.max(EPSILON, cost)
    };
  }

  const value = String(raw ?? "normal").toLowerCase();
  if (value === "0" || value === "none" || value === "wall" || value === "blocked" || value === "block") {
    return { type: "wall", rawType: raw, blocked: true, cost: Infinity };
  }
  if (value === "1" || value === "green" || value === "parcel" || value === "spawner" || value === "parcel_spawner") {
    return { type: "green", rawType: raw, blocked: false, cost: 1 };
  }
  if (value === "2" || value === "red" || value === "delivery" || value === "delivery_point") {
    return { type: "red", rawType: raw, blocked: false, cost: 1 };
  }
  if (value === "3" || value === "4" || value === "normal" || value === "base" || value === "walkable" || value === "white") {
    return { type: "normal", rawType: raw, blocked: false, cost: 1 };
  }

  // Unknown special cells stay traversable unless explicitly marked blocked.
  return { type: "special", rawType: raw, blocked: false, cost: 1 };
}

function makeEmptyGrid(width, height, fill = "wall") {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => normalizeCell(fill))
  );
}

function normalizeGrid(input, width, height) {
  if (Array.isArray(input?.grid)) {
    const inferredHeight = input.grid.length;
    const inferredWidth = input.grid.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
    const finalWidth = asNumber(width, inferredWidth);
    const finalHeight = asNumber(height, inferredHeight);
    const grid = makeEmptyGrid(finalWidth, finalHeight, "wall");

    for (let y = 0; y < finalHeight; y += 1) {
      const row = input.grid[y] ?? [];
      for (let x = 0; x < finalWidth; x += 1) {
        grid[y][x] = normalizeCell(row[x] ?? "wall");
      }
    }
    return { grid, width: finalWidth, height: finalHeight };
  }

  if (Array.isArray(input?.tiles)) {
    const maxX = input.tiles.reduce((max, tile) => Math.max(max, asNumber(tile.x, -1)), -1);
    const maxY = input.tiles.reduce((max, tile) => Math.max(max, asNumber(tile.y, -1)), -1);
    const finalWidth = Math.max(asNumber(width, input.width ?? 0), maxX + 1);
    const finalHeight = Math.max(asNumber(height, input.height ?? 0), maxY + 1);
    const grid = makeEmptyGrid(finalWidth, finalHeight, "wall");

    for (const tile of input.tiles) {
      const x = Math.round(asNumber(tile.x));
      const y = Math.round(asNumber(tile.y));
      if (x >= 0 && y >= 0 && x < finalWidth && y < finalHeight) {
        grid[y][x] = normalizeCell(tile.type ?? tile.kind ?? tile);
      }
    }
    return { grid, width: finalWidth, height: finalHeight };
  }

  const finalWidth = asNumber(width, input?.width ?? 0);
  const finalHeight = asNumber(height, input?.height ?? 0);
  return { grid: makeEmptyGrid(finalWidth, finalHeight, "normal"), width: finalWidth, height: finalHeight };
}

function normalizeMe(input) {
  const me = input.me ?? input.self ?? {};
  const position = me.position ?? me;
  return {
    ...me,
    position: copyPosition(position ?? { x: 0, y: 0 })
  };
}

function normalizeEnemies(input, meId) {
  const enemies = input.enemies ?? input.agents ?? [];
  return enemies
    .filter((enemy) => enemy && enemy.id !== meId)
    .map((enemy, index) => ({
      ...enemy,
      id: normalizeId("E", enemy.id ?? index, enemy.position ?? enemy),
      position: copyPosition(enemy.position ?? enemy),
      speed: Math.max(EPSILON, asNumber(enemy.speed, 1))
    }));
}

function packageFromParcel(parcel, params) {
  if (!parcel || parcel.carriedBy) return null;
  return {
    id: String(parcel.id ?? `package_${parcel.x}_${parcel.y}`),
    value: asNumber(parcel.value ?? parcel.reward, params.meanPackageValue),
    spawnTime: parcel.spawnTime ?? null,
    decayRate: asNumber(parcel.decayRate, params.decayRate),
    confidence: clamp(asNumber(parcel.confidence, 1), 0, 1),
    lastSeenTime: parcel.lastSeenTime ?? null,
    carriedBy: parcel.carriedBy
  };
}

function normalizePackage(pkg, params, fallbackId) {
  if (!pkg || pkg.carriedBy) return null;
  return {
    id: String(pkg.id ?? fallbackId),
    value: asNumber(pkg.value ?? pkg.reward, params.meanPackageValue),
    spawnTime: pkg.spawnTime ?? null,
    decayRate: asNumber(pkg.decayRate, params.decayRate),
    confidence: clamp(asNumber(pkg.confidence, 1), 0, 1),
    lastSeenTime: pkg.lastSeenTime ?? null,
    carriedBy: pkg.carriedBy
  };
}

function collectPoisFromGrid(grid, type, prefix) {
  const pois = [];
  for (let y = 0; y < grid.length; y += 1) {
    for (let x = 0; x < grid[y].length; x += 1) {
      if (grid[y][x].type === type) {
        const position = { x, y };
        pois.push({ id: normalizeId(prefix, null, position), position });
      }
    }
  }
  return pois;
}

function uniqueByPosition(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = positionKey(item.position);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function applyExplicitPoisToGrid(state) {
  for (const green of state.greens) {
    if (inBounds(state, green.position) && !state.grid[green.position.y][green.position.x].blocked) {
      state.grid[green.position.y][green.position.x] = { ...state.grid[green.position.y][green.position.x], type: "green" };
    }
  }
  for (const red of state.reds) {
    if (inBounds(state, red.position) && !state.grid[red.position.y][red.position.x].blocked) {
      state.grid[red.position.y][red.position.x] = { ...state.grid[red.position.y][red.position.x], type: "red" };
    }
  }
}

/**
 * Parse a JSON map/state into the normalized State used by the planner.
 * Accepts either an object or a JSON string.
 */
export function parseMap(json) {
  const input = typeof json === "string" ? JSON.parse(json) : json ?? {};
  const params = normalizeParams(input.params);
  const { grid, width, height } = normalizeGrid(input, input.width, input.height);
  const me = normalizeMe(input);
  const parcelByPosition = new Map();

  for (const parcel of input.parcels ?? []) {
    const position = copyPosition(parcel.position ?? parcel);
    parcelByPosition.set(positionKey(position), packageFromParcel(parcel, params));
  }

  const gridGreens = collectPoisFromGrid(grid, "green", "G");
  const explicitGreens = (input.greens ?? []).map((green, index) => {
    const position = copyPosition(green.position ?? green);
    const packageId = `package_${position.x}_${position.y}`;
    return {
      ...green,
      id: normalizeId("G", green.id ?? index, position),
      position,
      package: normalizePackage(green.package ?? parcelByPosition.get(positionKey(position)), params, packageId)
    };
  });

  const greensSource = explicitGreens.length > 0 ? [...explicitGreens, ...gridGreens] : gridGreens;
  const greens = uniqueByPosition(greensSource).map((green) => {
    const fallbackId = `package_${green.position.x}_${green.position.y}`;
    return {
      ...green,
      id: normalizeId("G", green.id, green.position),
      package: normalizePackage(green.package ?? parcelByPosition.get(positionKey(green.position)), params, fallbackId)
    };
  });

  const gridReds = collectPoisFromGrid(grid, "red", "R");
  const explicitReds = (input.reds ?? input.deliveryPoints ?? []).map((red, index) => {
    const position = copyPosition(red.position ?? red);
    return { ...red, id: normalizeId("R", red.id ?? index, position), position };
  });
  const redsSource = explicitReds.length > 0 ? [...explicitReds, ...gridReds] : gridReds;
  const reds = uniqueByPosition(redsSource).map((red) => ({
    ...red,
    id: normalizeId("R", red.id, red.position)
  }));

  const state = {
    width,
    height,
    grid,
    time: asNumber(input.time, 0),
    me,
    enemies: normalizeEnemies(input, me.id),
    carriedPackages: (input.carriedPackages ?? []).map((pkg) => ({ ...pkg })),
    greens,
    reds,
    params
  };

  applyExplicitPoisToGrid(state);
  return state;
}

export function inBounds(state, position) {
  return (
    position &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < state.width &&
    position.y < state.height
  );
}

export function getCell(state, position) {
  if (!inBounds(state, position)) return null;
  return state.grid[position.y]?.[position.x] ?? null;
}

export function isWalkable(state, position) {
  const cell = getCell(state, position);
  return !!cell && !cell.blocked;
}

export function manhattan(a, b) {
  return Math.abs(Math.round(a.x) - Math.round(b.x)) + Math.abs(Math.round(a.y) - Math.round(b.y));
}

function estimateDistance(_state, from, to) {
  return manhattan(from, to);
}

function rankingDistance(state, from, to) {
  const key = `${positionKey(from)}->${positionKey(to)}`;
  const cache = state.__rankingDistanceCache;
  if (cache?.has(key)) return cache.get(key);

  const profile = state.__mapProfile ?? buildMapProfile(state);
  let cost = manhattan(from, to);
  if (!profile.hasObstacles && profile.hasUniformCosts) {
    cache?.set(key, cost);
    return cost;
  }
  cost = shortestGridPath(state, from, to, profile).cost;
  cache?.set(key, cost);
  return cost;
}

export function buildMapProfile(state) {
  const totalCells = state.width * state.height;
  let obstacleCount = 0;
  let nonUniformCostCount = 0;

  for (const row of state.grid) {
    for (const cell of row) {
      if (cell.blocked) obstacleCount += 1;
      if (!cell.blocked && Math.abs(asNumber(cell.cost, 1) - 1) > EPSILON) nonUniformCostCount += 1;
    }
  }

  const hasDecay =
    asNumber(state.params?.decayRate, 0) > 0 ||
    state.greens.some((green) => asNumber(green.package?.decayRate, 0) > 0);

  return {
    totalCells,
    greenCount: state.greens.length,
    redCount: state.reds.length,
    obstacleCount,
    greenDensity: totalCells > 0 ? state.greens.length / totalCells : 0,
    redDensity: totalCells > 0 ? state.reds.length / totalCells : 0,
    obstacleDensity: totalCells > 0 ? obstacleCount / totalCells : 0,
    hasDecay,
    hasObstacles: obstacleCount > 0,
    hasUniformCosts: nonUniformCostCount === 0
  };
}

export function chooseConfig(profile, params = {}) {
  let mode = "DENSE_BEAM";
  let topK = 8;
  let beamWidth = 20;
  let maxPickupsBeforeDelivery = 3;

  if (profile.greenCount <= 15) {
    mode = "SMALL_EXACT";
    topK = profile.greenCount;
    beamWidth = 200;
    maxPickupsBeforeDelivery = 5;
  } else if (profile.greenCount <= 60) {
    mode = "MEDIUM_BEAM";
    topK = 12;
    beamWidth = 40;
    maxPickupsBeforeDelivery = 4;
  }

  const periodicBase = Math.max(
    0,
    Math.round(asNumber(params.periodicReplanTicks, DEFAULT_PARAMS.periodicReplanTicks))
  );
  const periodicReplanTicks =
    profile.hasDecay && periodicBase > 1 ? Math.max(1, Math.floor(periodicBase / 2)) : periodicBase;

  return {
    mode: params.mode ?? mode,
    topK: Math.max(0, Math.min(profile.greenCount, asNumber(params.topK, topK))),
    beamWidth: Math.max(1, Math.round(asNumber(params.beamWidth, beamWidth))),
    maxPickupsBeforeDelivery: Math.max(
      0,
      Math.round(asNumber(params.maxPickupsBeforeDelivery, maxPickupsBeforeDelivery))
    ),
    kSmoothMax: asNumber(params.kSmoothMax, DEFAULT_PARAMS.kSmoothMax),
    kWin: asNumber(params.kWin, DEFAULT_PARAMS.kWin),
    rhoGeneration: asNumber(params.rhoGeneration, DEFAULT_PARAMS.rhoGeneration),
    moveWeight: asNumber(params.moveWeight, DEFAULT_PARAMS.moveWeight),
    betaCarry: asNumber(params.betaCarry, DEFAULT_PARAMS.betaCarry),
    decayRate: asNumber(params.decayRate, DEFAULT_PARAMS.decayRate),
    meanPackageValue: asNumber(params.meanPackageValue, DEFAULT_PARAMS.meanPackageValue),
    generationMeanTime: params.generationMeanTime ?? DEFAULT_PARAMS.generationMeanTime,
    generationProbability: params.generationProbability ?? DEFAULT_PARAMS.generationProbability,
    maxPackages:
      params.maxPackages === null || params.maxPackages === undefined
        ? DEFAULT_PARAMS.maxPackages
        : asNumber(params.maxPackages, DEFAULT_PARAMS.maxPackages),
    minParcelConfidence: asNumber(params.minParcelConfidence, DEFAULT_PARAMS.minParcelConfidence),
    enemySafetyMargin: asNumber(params.enemySafetyMargin, DEFAULT_PARAMS.enemySafetyMargin),
    maxPlanningTimeMs: asNumber(params.maxPlanningTimeMs, DEFAULT_PARAMS.maxPlanningTimeMs),
    periodicReplanTicks
  };
}

export function sigmoid(x) {
  if (x >= 40) return 1;
  if (x <= -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function logSumExp(C, F, k) {
  if (k <= EPSILON) return Math.max(C, F);
  const maxValue = Math.max(C, F);
  return maxValue + Math.log(Math.exp(k * (C - maxValue)) + Math.exp(k * (F - maxValue))) / k;
}

export function winProbability(state, green, etaMe, config) {
  if (!state.enemies || state.enemies.length === 0) return 1;

  let probability = 1;
  for (const enemy of state.enemies) {
    const speed = Math.max(EPSILON, asNumber(enemy.speed, 1));
    const enemyEta = rankingDistance(state, enemy.position, green.position) / speed;
    probability = Math.min(probability, sigmoid(config.kWin * (enemyEta - etaMe)));
  }
  return probability;
}

function generationProbabilityForGreen(state, config) {
  const greenCount = Math.max(1, state.greens.length);
  if (config.generationProbability !== null && config.generationProbability !== undefined) {
    return clamp(asNumber(config.generationProbability, 0), 0, 1) / greenCount;
  }
  if (config.generationMeanTime !== null && config.generationMeanTime !== undefined) {
    return 1 / Math.max(1, asNumber(config.generationMeanTime, 1)) / greenCount;
  }
  return 1 / greenCount;
}

function expectedGenerationWait(config) {
  if (config.generationMeanTime !== null && config.generationMeanTime !== undefined) {
    return Math.max(0, asNumber(config.generationMeanTime, 0));
  }
  if (config.generationProbability !== null && config.generationProbability !== undefined) {
    const p = clamp(asNumber(config.generationProbability, 0), 0, 1);
    return p > EPSILON ? 1 / p : Infinity;
  }
  return 0;
}

function activePackageCount(state) {
  const onMap = state.greens.filter((green) => green.package && !green.package.carriedBy).length;
  const carried = state.carriedPackages?.length ?? 0;
  return onMap + carried;
}

function packageConfidence(green) {
  return clamp(asNumber(green.package?.confidence, 1), 0, 1);
}

function packageReward(green, fallbackValue) {
  return asNumber(green.package?.value ?? green.package?.reward, fallbackValue);
}

function packageDecayRate(green, fallbackRate) {
  return asNumber(green.package?.decayRate, fallbackRate);
}

function hasAvailablePackage(green, config) {
  if (!green.package || green.package.carriedBy) return false;
  if (packageConfidence(green) < config.minParcelConfidence) return false;
  if (packageReward(green, config.meanPackageValue) <= 0) return false;
  return true;
}

function nearestRedDistance(state, position) {
  if (!state.reds || state.reds.length === 0) return 0;
  return Math.min(...state.reds.map((red) => rankingDistance(state, position, red.position)));
}

export function currentGreenValue(state, green, config) {
  if (!hasAvailablePackage(green, config)) return 0;
  const etaMe = rankingDistance(state, state.me.position, green.position);
  const etaRed = nearestRedDistance(state, green.position);
  if (!Number.isFinite(etaMe) || !Number.isFinite(etaRed)) return 0;
  const etaTotal = etaMe + etaRed;
  const decayRate = packageDecayRate(green, config.decayRate);
  const currentValue = packageReward(green, config.meanPackageValue);
  const deliveryAwareValue = Math.max(0, currentValue - decayRate * etaTotal);
  return packageConfidence(green) * winProbability(state, green, etaMe, config) * deliveryAwareValue;
}

export function futureGreenValue(state, green, config) {
  if (activePackageCount(state) >= config.maxPackages) return 0;

  const etaMe = rankingDistance(state, state.me.position, green.position);
  if (!Number.isFinite(etaMe)) return 0;

  const etaRed = nearestRedDistance(state, green.position);
  if (!Number.isFinite(etaRed)) return 0;

  const wait = expectedGenerationWait(config);
  if (!Number.isFinite(wait)) return 0;

  const travelAfterSpawn = etaMe + etaRed;
  const expectedValue = Math.max(0, config.meanPackageValue - config.decayRate * travelAfterSpawn);
  const q = generationProbabilityForGreen(state, config);
  return q * expectedValue * Math.exp(-config.rhoGeneration * wait);
}

export function computeGreenScore(state, green, config) {
  const C = currentGreenValue(state, green, config);
  const F = futureGreenValue(state, green, config);
  return logSumExp(C, F, config.kSmoothMax);
}

export function computeGreenScores(state, config) {
  const scores = new Map();
  for (const green of state.greens) {
    scores.set(green.id, computeGreenScore(state, green, config));
  }
  return scores;
}

export function selectCandidateGreens(state, greenScores, config) {
  return [...state.greens]
    .filter((green) => hasAvailablePackage(green, config))
    .map((green) => {
      const score = greenScores.get(green.id) ?? 0;
      const distanceFromMe = rankingDistance(state, state.me.position, green.position);
      const distanceToRed = nearestRedDistance(state, green.position);
      if (!Number.isFinite(distanceFromMe) || !Number.isFinite(distanceToRed)) {
        return { green, score, priority: -Infinity };
      }
      const confidence = packageConfidence(green);
      const win = winProbability(state, green, distanceFromMe, config);
      const deliveryAwareReward = Math.max(
        0,
        packageReward(green, config.meanPackageValue) -
          packageDecayRate(green, config.decayRate) * (distanceFromMe + distanceToRed)
      );
      const rankingScore = (score + deliveryAwareReward) * confidence * win;
      const priority = rankingScore / (1 + distanceFromMe + distanceToRed);
      return { green, score, priority };
    })
    .filter((entry) => Number.isFinite(entry.priority))
    .sort((a, b) => b.priority - a.priority || b.score - a.score || a.green.id.localeCompare(b.green.id))
    .slice(0, config.topK)
    .map((entry) => entry.green);
}

export function buildPointsOfInterest(state, candidateGreens) {
  return [
    { id: "START", type: "start", position: copyPosition(state.me.position) },
    ...candidateGreens.map((green) => ({ ...green, type: "green", position: copyPosition(green.position) })),
    ...state.reds.map((red) => ({ ...red, type: "red", position: copyPosition(red.position) }))
  ];
}

function neighbors4(state, position) {
  return [
    { x: position.x + 1, y: position.y },
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y + 1 },
    { x: position.x, y: position.y - 1 }
  ].filter((next) => isWalkable(state, next));
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

    for (const next of neighbors4(state, current)) {
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

    for (const next of neighbors4(state, current)) {
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
  return Array.isArray(path) && path.every((position) => isWalkable(state, position));
}

export function shortestGridPath(state, from, to, profile = null) {
  if (!isWalkable(state, from) || !isWalkable(state, to)) return { cost: Infinity, path: [] };
  const mapProfile = profile ?? buildMapProfile(state);

  if (!mapProfile.hasObstacles && mapProfile.hasUniformCosts) {
    const direct = manhattanGridPath(from, to);
    if (pathIsWalkable(state, direct.path)) return direct;
    return bfsGridPath(state, from, to);
  }

  if (mapProfile.hasUniformCosts) return bfsGridPath(state, from, to);
  return aStarGridPath(state, from, to);
}

export function buildDistanceOracle(state, points) {
  const profile = buildMapProfile(state);
  const entries = new Map();
  const pointsById = new Map(points.map((point) => [point.id, point]));

  for (const from of points) {
    for (const to of points) {
      if (from.id === to.id) continue;
      const edge = shortestGridPath(state, from.position, to.position, profile);
      entries.set(pairKey(from.id, to.id), {
        fromId: from.id,
        toId: to.id,
        cost: edge.cost,
        path: edge.path
      });
    }
  }

  return { entries, points, pointsById, profile };
}

export function getOracleEdge(oracle, fromId, toId) {
  return oracle.entries.get(pairKey(fromId, toId)) ?? null;
}

export function initialPlan(state) {
  const carriedPackages = (state.carriedPackages ?? []).map((pkg) => ({
    greenId: pkg.greenId ?? "CARRIED",
    packageId: String(pkg.packageId ?? pkg.id),
    valueAtPickup: asNumber(pkg.valueAtPickup ?? pkg.value, 0),
    pickupTime: asNumber(pkg.pickupTime, asNumber(state.time, 0)),
    decayRate: asNumber(pkg.decayRate, state.params?.decayRate ?? DEFAULT_PARAMS.decayRate),
    confidence: clamp(asNumber(pkg.confidence, 1), 0, 1)
  }));

  return {
    sequence: ["START"],
    currentId: "START",
    currentPosition: copyPosition(state.me.position),
    time: asNumber(state.time, 0),
    moveCost: 0,
    pickedPackages: carriedPackages,
    pickedGreenIds: new Set(),
    deliveredScore: 0
  };
}

function packageValueAtPickup(state, green, pickupTime, config) {
  const pkg = green.package;
  if (!pkg || pkg.carriedBy) return 0;
  const currentValue = packageReward(green, config.meanPackageValue);
  const decayRate = packageDecayRate(green, config.decayRate);
  const elapsed = Math.max(0, pickupTime - asNumber(state.time, 0));
  return packageConfidence(green) * Math.max(0, currentValue - decayRate * elapsed);
}

function beatsEnemiesToGreen(state, green, etaMe, config) {
  if (!state.enemies || state.enemies.length === 0) return true;
  const margin = asNumber(config.enemySafetyMargin, 0);
  return state.enemies.every((enemy) => {
    const speed = Math.max(EPSILON, asNumber(enemy.speed, 1));
    const enemyEta = rankingDistance(state, enemy.position, green.position) / speed;
    return etaMe + margin <= enemyEta + EPSILON;
  });
}

export function extendToGreen(plan, green, state, oracle, config) {
  if (plan.pickedGreenIds.has(green.id)) return null;
  if (!hasAvailablePackage(green, config)) return null;

  const edge = getOracleEdge(oracle, plan.currentId, green.id);
  if (!edge || !Number.isFinite(edge.cost)) return null;

  const arrivalTime = plan.time + edge.cost;
  const etaFromNow = Math.max(0, arrivalTime - asNumber(state.time, 0));
  if (!beatsEnemiesToGreen(state, green, etaFromNow, config)) return null;

  const valueAtPickup = packageValueAtPickup(state, green, arrivalTime, config);
  if (valueAtPickup <= EPSILON) return null;

  const decayRate = packageDecayRate(green, config.decayRate);
  const pickedGreenIds = new Set(plan.pickedGreenIds);
  pickedGreenIds.add(green.id);

  return {
    ...plan,
    sequence: [...plan.sequence, green.id],
    currentId: green.id,
    currentPosition: copyPosition(green.position),
    time: arrivalTime,
    moveCost: plan.moveCost + edge.cost,
    pickedPackages: [
      ...plan.pickedPackages,
      {
        greenId: green.id,
        packageId: String(green.package.id),
        valueAtPickup,
        pickupTime: arrivalTime,
        decayRate,
        confidence: packageConfidence(green)
      }
    ],
    pickedGreenIds
  };
}

export function computeDeliveredValue(pickedPackages, deliveryTime) {
  return pickedPackages.reduce((sum, pkg) => {
    const elapsed = Math.max(0, deliveryTime - pkg.pickupTime);
    return sum + Math.max(0, pkg.valueAtPickup - pkg.decayRate * elapsed);
  }, 0);
}

export function extendToRed(plan, red, _state, oracle, _config) {
  if (plan.pickedPackages.length === 0) return null;

  const edge = getOracleEdge(oracle, plan.currentId, red.id);
  if (!edge || !Number.isFinite(edge.cost)) return null;

  const deliveryTime = plan.time + edge.cost;
  const delivered = computeDeliveredValue(plan.pickedPackages, deliveryTime);

  return {
    ...plan,
    sequence: [...plan.sequence, red.id],
    currentId: red.id,
    currentPosition: copyPosition(red.position),
    time: deliveryTime,
    moveCost: plan.moveCost + edge.cost,
    pickedPackages: [],
    deliveredScore: plan.deliveredScore + delivered
  };
}

export function carriedPotential(plan, _state, oracle, config = null) {
  if (plan.pickedPackages.length === 0) return 0;
  const reds = oracle.points.filter((point) => point.type === "red");
  if (reds.length === 0) return 0;

  let best = -Infinity;
  const moveWeight = asNumber(config?.moveWeight, 0);
  for (const red of reds) {
    const edge = getOracleEdge(oracle, plan.currentId, red.id);
    if (!edge || !Number.isFinite(edge.cost)) continue;
    const deliveryTime = plan.time + edge.cost;
    const delivered = computeDeliveredValue(plan.pickedPackages, deliveryTime);
    best = Math.max(best, delivered - moveWeight * edge.cost);
  }
  return Number.isFinite(best) ? best : 0;
}

export function planValue(plan, state, oracle, config) {
  return (
    plan.deliveredScore +
    config.betaCarry * carriedPotential(plan, state, oracle, config) -
    config.moveWeight * plan.moveCost
  );
}

export function betterPlan(a, b, state, oracle, config) {
  if (!a) return b;
  if (!b) return a;

  const aValue = planValue(a, state, oracle, config);
  const bValue = planValue(b, state, oracle, config);
  if (bValue > aValue + EPSILON) return b;
  if (aValue > bValue + EPSILON) return a;
  if (b.deliveredScore > a.deliveredScore + EPSILON) return b;
  if (a.deliveredScore > b.deliveredScore + EPSILON) return a;
  return b.moveCost < a.moveCost ? b : a;
}

export function findBestSequence(state, points, oracle, _greenScores, config) {
  const greens = points.filter((point) => point.type === "green");
  const reds = points.filter((point) => point.type === "red");
  let beam = [initialPlan(state)];
  let bestComplete = null;
  let bestPartial = null;
  const maxCarriedBeforeDelivery = Math.max(0, Math.round(asNumber(config.maxPickupsBeforeDelivery, 0)));

  for (let depth = 0; depth < config.maxPickupsBeforeDelivery; depth += 1) {
    const nextBeam = [];

    for (const plan of beam) {
      for (const red of reds) {
        const deliveredPlan = extendToRed(plan, red, state, oracle, config);
        if (deliveredPlan) {
          bestComplete = betterPlan(bestComplete, deliveredPlan, state, oracle, config);
        }
      }

      if (plan.pickedPackages.length < maxCarriedBeforeDelivery) {
        for (const green of greens) {
          const nextPlan = extendToGreen(plan, green, state, oracle, config);
          if (nextPlan) {
            nextBeam.push(nextPlan);
            bestPartial = betterPlan(bestPartial, nextPlan, state, oracle, config);
          }
        }
      }
    }

    nextBeam.sort((a, b) => planValue(b, state, oracle, config) - planValue(a, state, oracle, config));
    beam = nextBeam.slice(0, config.beamWidth);
    if (beam.length === 0) break;
  }

  for (const plan of beam) {
    for (const red of reds) {
      const deliveredPlan = extendToRed(plan, red, state, oracle, config);
      if (deliveredPlan) {
        bestComplete = betterPlan(bestComplete, deliveredPlan, state, oracle, config);
      }
    }
  }

  const fallback = bestPartial ?? initialPlan(state);
  const best = bestComplete ?? fallback;
  return { ...best, value: planValue(best, state, oracle, config) };
}

export function reconstructGridPath(sequence, oracle) {
  if (!Array.isArray(sequence) || sequence.length === 0) return [];
  const startPoint = oracle.pointsById.get(sequence[0]);
  const fullPath = startPoint ? [copyPosition(startPoint.position)] : [];

  for (let i = 0; i < sequence.length - 1; i += 1) {
    const edge = getOracleEdge(oracle, sequence[i], sequence[i + 1]);
    if (!edge || !Number.isFinite(edge.cost) || edge.path.length === 0) break;
    const segment = i === 0 && fullPath.length === 0 ? edge.path : edge.path.slice(1);
    fullPath.push(...segment.map(copyPosition));
  }

  return fullPath;
}

function baseRoutePlan({
  mode,
  sequence,
  path,
  value,
  plan,
  profile,
  config,
  greenScores,
  candidateGreens = [],
  oracle,
  state,
  scoutTarget = null
}) {
  return {
    mode,
    sequence,
    path,
    value,
    plan,
    profile,
    config,
    greenScores: mapToObject(greenScores),
    candidateGreens,
    scoutTarget,
    oracle,
    state,
    generatedAtTime: asNumber(state.time, 0),
    pathIndex: 0
  };
}

function buildIdlePlan(state, profile, config, greenScores) {
  const startPoint = { id: "START", type: "start", position: copyPosition(state.me.position) };
  const oracle = {
    entries: new Map(),
    points: [startPoint],
    pointsById: new Map([["START", startPoint]]),
    profile
  };

  return baseRoutePlan({
    mode: "IDLE",
    sequence: ["START"],
    path: [copyPosition(state.me.position)],
    value: 0,
    plan: initialPlan(state),
    profile,
    config,
    greenScores,
    oracle,
    state
  });
}

function buildDeliveryOnlyPlan(state, profile, config, greenScores) {
  if (!state.reds || state.reds.length === 0 || (state.carriedPackages ?? []).length === 0) return null;

  const points = buildPointsOfInterest(state, []);
  const oracle = buildDistanceOracle(state, points);
  const startPlan = initialPlan(state);
  let bestPlan = null;

  for (const red of points.filter((point) => point.type === "red")) {
    const deliveredPlan = extendToRed(startPlan, red, state, oracle, config);
    if (deliveredPlan) {
      bestPlan = betterPlan(bestPlan, deliveredPlan, state, oracle, config);
    }
  }

  if (!bestPlan) return null;
  const path = reconstructGridPath(bestPlan.sequence, oracle);

  return baseRoutePlan({
    mode: "DELIVERY_ONLY",
    sequence: bestPlan.sequence,
    path,
    value: planValue(bestPlan, state, oracle, config),
    plan: bestPlan,
    profile,
    config,
    greenScores,
    oracle,
    state
  });
}

function buildPickupDeliveryPlan(state, profile, config, greenScores, candidateGreens) {
  const points = buildPointsOfInterest(state, candidateGreens);
  const oracle = buildDistanceOracle(state, points);
  const bestPlan = findBestSequence(state, points, oracle, greenScores, config);
  const path = reconstructGridPath(bestPlan.sequence, oracle);

  return baseRoutePlan({
    mode: "PICKUP_DELIVERY",
    sequence: bestPlan.sequence,
    path,
    value: bestPlan.value,
    plan: bestPlan,
    profile,
    config,
    greenScores,
    candidateGreens,
    oracle,
    state
  });
}

function buildScoutPlan(state, profile, config, greenScores) {
  let best = null;

  for (const green of state.greens) {
    if (!isWalkable(state, green.position)) continue;

    const edge = shortestGridPath(state, state.me.position, green.position, profile);
    if (!Number.isFinite(edge.cost) || edge.path.length === 0) continue;
    if (edge.cost === 0) continue;

    const distanceToNearestRed = nearestRedDistance(state, green.position);
    const redDistance = Number.isFinite(distanceToNearestRed) ? distanceToNearestRed : 0;
    const futureScore = greenScores.get(green.id) ?? 0;
    const scoutPriority = (1 + futureScore) / (1 + edge.cost + 0.25 * redDistance);

    if (!best || scoutPriority > best.scoutPriority) {
      best = { green, edge, scoutPriority };
    }
  }

  if (!best) return null;

  const startPoint = { id: "START", type: "start", position: copyPosition(state.me.position) };
  const scoutPoint = {
    id: `SCOUT_${best.green.id}`,
    type: "scout",
    position: copyPosition(best.green.position),
    sourceGreenId: best.green.id,
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
    value: best.scoutPriority,
    plan: initialPlan(state),
    profile,
    config,
    greenScores,
    candidateGreens: [],
    scoutTarget: best.green,
    oracle,
    state
  });
}

function buildLocalExplorePlan(state, profile, config) {
  const start = copyPosition(state.me.position);
  const candidates = [
    { x: start.x + 1, y: start.y },
    { x: start.x - 1, y: start.y },
    { x: start.x, y: start.y + 1 },
    { x: start.x, y: start.y - 1 }
  ];

  for (const position of candidates) {
    if (!isWalkable(state, position)) continue;

    const edge = shortestGridPath(state, start, position, profile);
    if (!Number.isFinite(edge.cost) || edge.path.length < 2) continue;

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
      value: 0,
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

export function replan(state) {
  const planningState = parseMap(state);
  const profile = buildMapProfile(planningState);
  Object.defineProperty(planningState, "__mapProfile", { value: profile, enumerable: false });
  Object.defineProperty(planningState, "__rankingDistanceCache", { value: new Map(), enumerable: false });
  const config = chooseConfig(profile, planningState.params);
  const greenScores = computeGreenScores(planningState, config);
  const candidateGreens = selectCandidateGreens(planningState, greenScores, config);

  if ((planningState.carriedPackages ?? []).length > 0) {
    const deliveryPlan = buildDeliveryOnlyPlan(planningState, profile, config, greenScores);
    if (deliveryPlan) return deliveryPlan;
  }

  if ((planningState.carriedPackages ?? []).length === 0 && candidateGreens.length > 0) {
    return buildPickupDeliveryPlan(planningState, profile, config, greenScores, candidateGreens);
  }

  const scoutPlan = buildScoutPlan(planningState, profile, config, greenScores);
  if (scoutPlan) return scoutPlan;

  const localExplorePlan = buildLocalExplorePlan(planningState, profile, config);
  if (localExplorePlan) return localExplorePlan;

  return buildIdlePlan(planningState, profile, config, greenScores);
}

export function directionFromPositions(from, to) {
  if (!from || !to) return null;
  if (to.x > from.x) return "right";
  if (to.x < from.x) return "left";
  if (to.y > from.y) return "up";
  if (to.y < from.y) return "down";
  return null;
}
