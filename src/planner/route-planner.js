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
  periodicReplanTicks: 20,
  minParcelConfidence: 0.3,
  enemySafetyMargin: 0,
  maxPlanningTimeMs: 30,
  scoutCooldownTicks: 8,
  sameScoutTargetPenalty: 15,
  recentScoutPenalty: 10,
  scoutDistanceWeight: 0.8,
  scoutRedDistanceWeight: 0.1,
  scoutFutureWeight: 2,
  scoutCongestionDistance: 2,
  scoutEnemyDistance: 2,
  scoutCongestionPenalty: 10,
  noveltyBonus: 5,
  emptyGreenFutureWeight: 0,
  maxStalenessValue: 30,
  greenInfoMultiplier: 4,
  redInfoMultiplier: 0.2,
  infoValueWeight: 1,
  sensingRange: 5,
  clusterPickupRadius: 3,
  clusterPickupBonusWeight: 0.6,
  minClusterPackageValue: 3,
  greenClusterDistance: 2,
  clusterSizeWeight: 3,
  explorationDebtThreshold: 25,
  explorationDebtBonus: 30,
  localCandidateRadius: 4,
  localCandidateLimit: 4,
  clusterExpansionRadius: 3,
  clusterExpansionLimit: 6,
  maxCandidateGreens: 16,
  localExploreReversePenalty: 20,
  localExploreInfoWeight: 1,
  denseGreenThreshold: 0.65,
  denseGreenMinGreens: 100,
  denseScoutRadius: 6,
  denseScoutMaxWaypoints: 12,
  denseScoutMinDistanceFromLastDelivery: 2,
  greenExposureDepth: 6,
  greenExposureBeamWidth: 16,
  greenExposureMaxExpanded: 48,
  greenExposureMinPlanLength: 3,
  greenExposureStaleWeight: 2,
  greenExposureNewTileWeight: 1,
  greenExposureGreenWeight: 1,
  greenExposureDistanceWeight: 1,
  greenExposureBacktrackPenalty: 5,
  minGreenExposureScore: 0,
  positionRevisitPenalty: 4,
  edgeRevisitPenalty: 6,
  sameTargetPenalty: 30,
  sameSectorPenalty: 20,
  failedScoutTargetPenalty: 50,
  failedScoutTargetCooldownTicks: 40,
  edgeCooldownTicks: 20,
  positionCooldownTicks: 20,
  coverageSectorSize: 5,
  returnToRedWeight: 0.5,
  trapPenalty: 10000,
  planningBudgetMs: 30,
  hardPlanningBudgetMs: 100,
  mazeObstacleDensityThreshold: 0.25,
  enableEdgeTemporaryBlocks: true,
  temporaryEdgeBlockTtlTicks: 2,
  maxRepeatedBlockedMovesBeforeReplan: 2,
  opportunisticMaxDistance: 3,
  opportunisticPathRadius: 2,
  opportunisticCheckIntervalTicks: 2,
  opportunisticMinGain: 5,
  opportunisticCongestionPenalty: 8,
  targetCongestionPenalty: 0,
  deliveryUrgencyWeight: 0
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

function normalizeVisitedGreenAt(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value === "object") return { ...value };
  return {};
}

function normalizeObservationMap(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value === "object") return { ...value };
  return {};
}

function directionConstraintFromValue(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const symbols = {
    "\u2192": "right",
    "\u2190": "left",
    "\u2191": "up",
    "\u2193": "down",
    "\u27a1": "right",
    "\u2b05": "left",
    "\u2b06": "up",
    "\u2b07": "down"
  };
  if (symbols[normalized]) return symbols[normalized];
  const match = normalized.match(/^(?:arrow|one_way|oneway|directional)_(up|down|left|right)$/);
  return match?.[1] ?? null;
}

function normalizeCell(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const normalized = normalizeCell(raw.type ?? raw.kind ?? raw.tile ?? "normal");
    const blocked = raw.blocked === true || raw.walkable === false || normalized.blocked;
    const cost = asNumber(raw.cost ?? raw.moveCost ?? normalized.cost, normalized.cost);
    const directionConstraintRaw =
      raw.directionConstraint ??
      raw.exitDirection ??
      raw.direction ??
      normalized.directionConstraint ??
      directionConstraintFromValue(raw.type ?? raw.kind ?? raw.tile);
    const entryConstraintRaw =
      raw.entryConstraint ??
      raw.enterDirection ??
      normalized.entryConstraint ??
      null;
    const directionConstraint =
      directionConstraintFromValue(directionConstraintRaw) ??
      directionConstraintFromValue(`arrow_${directionConstraintRaw}`) ??
      directionConstraintRaw ??
      null;
    const entryConstraint =
      directionConstraintFromValue(entryConstraintRaw) ??
      directionConstraintFromValue(`arrow_${entryConstraintRaw}`) ??
      entryConstraintRaw ??
      null;
    return {
      type: blocked ? "wall" : normalized.type,
      rawType: raw.type ?? normalized.rawType,
      blocked,
      cost: blocked ? Infinity : Math.max(EPSILON, cost),
      directionConstraint: blocked ? null : directionConstraint,
      entryConstraint: blocked ? null : entryConstraint
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
  const directionConstraint = directionConstraintFromValue(value);
  if (directionConstraint) {
    return {
      type: "special",
      rawType: raw,
      blocked: false,
      cost: 1,
      directionConstraint,
      entryConstraint: null
    };
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
    visitedGreenAt: normalizeVisitedGreenAt(input.visitedGreenAt),
    lastScoutTargetId: input.lastScoutTargetId ?? null,
    lastPosition: input.lastPosition ? copyPosition(input.lastPosition) : null,
    recentPositions: Array.isArray(input.recentPositions) ? input.recentPositions.map(copyPosition) : [],
    temporaryBlockedCells: input.temporaryBlockedCells ?? null,
    temporaryBlockedEdges: input.temporaryBlockedEdges ?? null,
    visitedPositions: normalizeObservationMap(input.visitedPositions),
    visitedEdges: normalizeObservationMap(input.visitedEdges),
    scoutTargetAttempts: normalizeObservationMap(input.scoutTargetAttempts),
    recentScoutTargets: Array.isArray(input.recentScoutTargets) ? input.recentScoutTargets.map(String) : [],
    lastDeliveryPosition: input.lastDeliveryPosition ? copyPosition(input.lastDeliveryPosition) : null,
    lastObservedAtByTile: normalizeObservationMap(input.lastObservedAtByTile),
    lastObservedAtByGreen: normalizeObservationMap(input.lastObservedAtByGreen),
    sensingRange: asNumber(input.sensingRange, params.sensingRange),
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
  return !!cell && !cell.blocked && !isTemporarilyBlockedCell(state, position);
}

function edgeKey(from, to) {
  return `${positionKey(from)}->${positionKey(to)}`;
}

function isTemporarilyBlockedEdge(state, from, to) {
  const key = edgeKey(from, to);
  const blocks = state.temporaryBlockedEdges;
  if (!blocks) return false;

  const block =
    blocks instanceof Map
      ? blocks.get(key)
      : Array.isArray(blocks)
        ? blocks.find((entry) => entry.key === key || edgeKey(entry.from ?? entry, entry.to ?? entry) === key)
        : blocks[key];
  if (!block) return false;
  if (typeof block === "object" && Number.isFinite(Number(block.expiresAt))) {
    return Number(block.expiresAt) > asNumber(state.time, 0);
  }
  return true;
}

function isTemporarilyBlockedCell(state, position) {
  const key = positionKey(position);
  const blocks = state.temporaryBlockedCells;
  if (!blocks) return false;

  const block =
    blocks instanceof Map
      ? blocks.get(key)
      : Array.isArray(blocks)
        ? blocks.find((entry) => positionKey(entry.position ?? entry) === key)
        : blocks[key];
  if (!block) return false;
  if (typeof block === "object" && Number.isFinite(Number(block.expiresAt))) {
    return Number(block.expiresAt) > asNumber(state.time, 0);
  }
  return true;
}

export function isMoveAllowed(state, from, to) {
  const fromCell = getCell(state, from);
  const toCell = getCell(state, to);
  if (!fromCell || fromCell.blocked || !toCell || toCell.blocked) return false;
  if (isTemporarilyBlockedCell(state, from) || isTemporarilyBlockedCell(state, to)) return false;
  if (isTemporarilyBlockedEdge(state, from, to)) return false;

  const direction = directionFromPositions(from, to);
  if (!direction) return false;

  if (fromCell.directionConstraint && fromCell.directionConstraint !== direction) return false;
  if (toCell.entryConstraint && toCell.entryConstraint !== direction) return false;
  return true;
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

  if (positionKey(from) === positionKey(state.me.position)) {
    const directed = distanceFromMe(state, to);
    if (Number.isFinite(directed)) {
      cache?.set(key, directed);
      return directed;
    }
  }

  const profile = state.__mapProfile ?? buildMapProfile(state);
  let cost = manhattan(from, to);
  if (!profile.hasObstacles && !profile.hasDirectionalTiles && profile.hasUniformCosts) {
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
  let directionalConstraintCount = 0;

  for (const row of state.grid) {
    for (const cell of row) {
      if (cell.blocked) obstacleCount += 1;
      if (!cell.blocked && Math.abs(asNumber(cell.cost, 1) - 1) > EPSILON) nonUniformCostCount += 1;
      if (!cell.blocked && (cell.directionConstraint || cell.entryConstraint)) directionalConstraintCount += 1;
    }
  }

  const totalWalkableCells = Math.max(0, totalCells - obstacleCount);
  const greenDensity = totalWalkableCells > 0 ? state.greens.length / totalWalkableCells : 0;
  const denseGreenThreshold = asNumber(state.params?.denseGreenThreshold, DEFAULT_PARAMS.denseGreenThreshold);
  const denseGreenMinGreens = asNumber(state.params?.denseGreenMinGreens, DEFAULT_PARAMS.denseGreenMinGreens);
  const obstacleDensity = totalCells > 0 ? obstacleCount / totalCells : 0;
  const mazeObstacleDensityThreshold = asNumber(
    state.params?.mazeObstacleDensityThreshold,
    DEFAULT_PARAMS.mazeObstacleDensityThreshold
  );
  const hasDecay =
    asNumber(state.params?.decayRate, 0) > 0 ||
    state.greens.some((green) => asNumber(green.package?.decayRate, 0) > 0);

  return {
    totalCells,
    totalWalkableCells,
    greenCount: state.greens.length,
    redCount: state.reds.length,
    obstacleCount,
    greenDensity,
    redDensity: totalCells > 0 ? state.reds.length / totalCells : 0,
    obstacleDensity,
    isDenseGreen: greenDensity >= denseGreenThreshold && state.greens.length >= denseGreenMinGreens,
    isMazeLike: obstacleDensity >= mazeObstacleDensityThreshold || directionalConstraintCount > 0,
    hasDecay,
    hasObstacles: obstacleCount > 0,
    hasDirectionalTiles: directionalConstraintCount > 0,
    hasDirectionalConstraints: directionalConstraintCount > 0,
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
    scoutCooldownTicks: asNumber(params.scoutCooldownTicks, DEFAULT_PARAMS.scoutCooldownTicks),
    sameScoutTargetPenalty: asNumber(params.sameScoutTargetPenalty, DEFAULT_PARAMS.sameScoutTargetPenalty),
    recentScoutPenalty: asNumber(params.recentScoutPenalty, DEFAULT_PARAMS.recentScoutPenalty),
    scoutDistanceWeight: asNumber(params.scoutDistanceWeight, DEFAULT_PARAMS.scoutDistanceWeight),
    scoutRedDistanceWeight: asNumber(params.scoutRedDistanceWeight, DEFAULT_PARAMS.scoutRedDistanceWeight),
    scoutFutureWeight: asNumber(params.scoutFutureWeight, DEFAULT_PARAMS.scoutFutureWeight),
    scoutCongestionDistance: asNumber(
      params.scoutCongestionDistance ?? params.scoutEnemyDistance,
      DEFAULT_PARAMS.scoutCongestionDistance
    ),
    scoutEnemyDistance: asNumber(params.scoutEnemyDistance, DEFAULT_PARAMS.scoutEnemyDistance),
    scoutCongestionPenalty: asNumber(params.scoutCongestionPenalty, DEFAULT_PARAMS.scoutCongestionPenalty),
    noveltyBonus: asNumber(params.noveltyBonus, DEFAULT_PARAMS.noveltyBonus),
    emptyGreenFutureWeight: asNumber(params.emptyGreenFutureWeight, DEFAULT_PARAMS.emptyGreenFutureWeight),
    maxStalenessValue: asNumber(params.maxStalenessValue, DEFAULT_PARAMS.maxStalenessValue),
    greenInfoMultiplier: asNumber(params.greenInfoMultiplier, DEFAULT_PARAMS.greenInfoMultiplier),
    redInfoMultiplier: asNumber(params.redInfoMultiplier, DEFAULT_PARAMS.redInfoMultiplier),
    infoValueWeight: asNumber(params.infoValueWeight, DEFAULT_PARAMS.infoValueWeight),
    sensingRange: asNumber(params.sensingRange, DEFAULT_PARAMS.sensingRange),
    clusterPickupRadius: asNumber(params.clusterPickupRadius, DEFAULT_PARAMS.clusterPickupRadius),
    clusterPickupBonusWeight: asNumber(params.clusterPickupBonusWeight, DEFAULT_PARAMS.clusterPickupBonusWeight),
    minClusterPackageValue: asNumber(params.minClusterPackageValue, DEFAULT_PARAMS.minClusterPackageValue),
    greenClusterDistance: asNumber(params.greenClusterDistance, DEFAULT_PARAMS.greenClusterDistance),
    clusterSizeWeight: asNumber(params.clusterSizeWeight, DEFAULT_PARAMS.clusterSizeWeight),
    explorationDebtThreshold: asNumber(params.explorationDebtThreshold, DEFAULT_PARAMS.explorationDebtThreshold),
    explorationDebtBonus: asNumber(params.explorationDebtBonus, DEFAULT_PARAMS.explorationDebtBonus),
    localCandidateRadius: asNumber(params.localCandidateRadius, DEFAULT_PARAMS.localCandidateRadius),
    localCandidateLimit: Math.max(
      0,
      Math.round(asNumber(params.localCandidateLimit, DEFAULT_PARAMS.localCandidateLimit))
    ),
    clusterExpansionRadius: asNumber(params.clusterExpansionRadius, DEFAULT_PARAMS.clusterExpansionRadius),
    clusterExpansionLimit: Math.max(
      0,
      Math.round(asNumber(params.clusterExpansionLimit, DEFAULT_PARAMS.clusterExpansionLimit))
    ),
    maxCandidateGreens: Math.max(
      0,
      Math.round(asNumber(params.maxCandidateGreens, DEFAULT_PARAMS.maxCandidateGreens))
    ),
    localExploreReversePenalty: asNumber(
      params.localExploreReversePenalty,
      DEFAULT_PARAMS.localExploreReversePenalty
    ),
    localExploreInfoWeight: asNumber(params.localExploreInfoWeight, DEFAULT_PARAMS.localExploreInfoWeight),
    denseGreenThreshold: asNumber(params.denseGreenThreshold, DEFAULT_PARAMS.denseGreenThreshold),
    denseGreenMinGreens: asNumber(params.denseGreenMinGreens, DEFAULT_PARAMS.denseGreenMinGreens),
    denseScoutRadius: asNumber(params.denseScoutRadius, DEFAULT_PARAMS.denseScoutRadius),
    denseScoutMaxWaypoints: Math.max(
      1,
      Math.round(asNumber(params.denseScoutMaxWaypoints, DEFAULT_PARAMS.denseScoutMaxWaypoints))
    ),
    denseScoutMinDistanceFromLastDelivery: asNumber(
      params.denseScoutMinDistanceFromLastDelivery,
      DEFAULT_PARAMS.denseScoutMinDistanceFromLastDelivery
    ),
    greenExposureDepth: Math.max(1, Math.round(asNumber(params.greenExposureDepth, DEFAULT_PARAMS.greenExposureDepth))),
    greenExposureBeamWidth: Math.max(
      1,
      Math.round(asNumber(params.greenExposureBeamWidth, DEFAULT_PARAMS.greenExposureBeamWidth))
    ),
    greenExposureMaxExpanded: Math.max(
      1,
      Math.round(asNumber(params.greenExposureMaxExpanded, DEFAULT_PARAMS.greenExposureMaxExpanded))
    ),
    greenExposureMinPlanLength: Math.max(
      1,
      Math.round(asNumber(params.greenExposureMinPlanLength, DEFAULT_PARAMS.greenExposureMinPlanLength))
    ),
    greenExposureStaleWeight: asNumber(params.greenExposureStaleWeight, DEFAULT_PARAMS.greenExposureStaleWeight),
    greenExposureNewTileWeight: asNumber(params.greenExposureNewTileWeight, DEFAULT_PARAMS.greenExposureNewTileWeight),
    greenExposureGreenWeight: asNumber(params.greenExposureGreenWeight, DEFAULT_PARAMS.greenExposureGreenWeight),
    greenExposureDistanceWeight: asNumber(
      params.greenExposureDistanceWeight,
      DEFAULT_PARAMS.greenExposureDistanceWeight
    ),
    greenExposureBacktrackPenalty: asNumber(
      params.greenExposureBacktrackPenalty,
      DEFAULT_PARAMS.greenExposureBacktrackPenalty
    ),
    minGreenExposureScore: asNumber(params.minGreenExposureScore, DEFAULT_PARAMS.minGreenExposureScore),
    positionRevisitPenalty: asNumber(params.positionRevisitPenalty, DEFAULT_PARAMS.positionRevisitPenalty),
    edgeRevisitPenalty: asNumber(params.edgeRevisitPenalty, DEFAULT_PARAMS.edgeRevisitPenalty),
    sameTargetPenalty: asNumber(params.sameTargetPenalty, DEFAULT_PARAMS.sameTargetPenalty),
    sameSectorPenalty: asNumber(params.sameSectorPenalty, DEFAULT_PARAMS.sameSectorPenalty),
    failedScoutTargetPenalty: asNumber(params.failedScoutTargetPenalty, DEFAULT_PARAMS.failedScoutTargetPenalty),
    failedScoutTargetCooldownTicks: asNumber(
      params.failedScoutTargetCooldownTicks,
      DEFAULT_PARAMS.failedScoutTargetCooldownTicks
    ),
    edgeCooldownTicks: asNumber(params.edgeCooldownTicks, DEFAULT_PARAMS.edgeCooldownTicks),
    positionCooldownTicks: asNumber(params.positionCooldownTicks, DEFAULT_PARAMS.positionCooldownTicks),
    coverageSectorSize: Math.max(1, Math.round(asNumber(params.coverageSectorSize, DEFAULT_PARAMS.coverageSectorSize))),
    returnToRedWeight: asNumber(params.returnToRedWeight, DEFAULT_PARAMS.returnToRedWeight),
    trapPenalty: asNumber(params.trapPenalty, DEFAULT_PARAMS.trapPenalty),
    planningBudgetMs: asNumber(params.planningBudgetMs, DEFAULT_PARAMS.planningBudgetMs),
    hardPlanningBudgetMs: asNumber(params.hardPlanningBudgetMs, DEFAULT_PARAMS.hardPlanningBudgetMs),
    mazeObstacleDensityThreshold: asNumber(
      params.mazeObstacleDensityThreshold,
      DEFAULT_PARAMS.mazeObstacleDensityThreshold
    ),
    enableEdgeTemporaryBlocks: params.enableEdgeTemporaryBlocks ?? DEFAULT_PARAMS.enableEdgeTemporaryBlocks,
    temporaryEdgeBlockTtlTicks: Math.max(
      1,
      Math.round(asNumber(params.temporaryEdgeBlockTtlTicks, DEFAULT_PARAMS.temporaryEdgeBlockTtlTicks))
    ),
    maxRepeatedBlockedMovesBeforeReplan: Math.max(
      1,
      Math.round(
        asNumber(
          params.maxRepeatedBlockedMovesBeforeReplan,
          DEFAULT_PARAMS.maxRepeatedBlockedMovesBeforeReplan
        )
      )
    ),
    opportunisticMaxDistance: asNumber(params.opportunisticMaxDistance, DEFAULT_PARAMS.opportunisticMaxDistance),
    opportunisticPathRadius: asNumber(params.opportunisticPathRadius, DEFAULT_PARAMS.opportunisticPathRadius),
    opportunisticCheckIntervalTicks: Math.max(
      1,
      Math.round(asNumber(params.opportunisticCheckIntervalTicks, DEFAULT_PARAMS.opportunisticCheckIntervalTicks))
    ),
    opportunisticMinGain: asNumber(params.opportunisticMinGain, DEFAULT_PARAMS.opportunisticMinGain),
    opportunisticCongestionPenalty: asNumber(
      params.opportunisticCongestionPenalty,
      DEFAULT_PARAMS.opportunisticCongestionPenalty
    ),
    targetCongestionPenalty: asNumber(params.targetCongestionPenalty, DEFAULT_PARAMS.targetCongestionPenalty),
    deliveryUrgencyWeight: asNumber(params.deliveryUrgencyWeight, DEFAULT_PARAMS.deliveryUrgencyWeight),
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

function buildNearestRedDistanceMap(state, profile = null) {
  const mapProfile = profile ?? buildMapProfile(state);
  const distanceByKey = new Map();
  if (!state.reds || state.reds.length === 0 || !mapProfile.hasUniformCosts || mapProfile.hasDirectionalConstraints) {
    return distanceByKey;
  }

  const queue = [];
  let head = 0;
  for (const red of state.reds) {
    if (!isWalkable(state, red.position)) continue;
    const key = positionKey(red.position);
    if (distanceByKey.has(key)) continue;
    distanceByKey.set(key, 0);
    queue.push(copyPosition(red.position));
  }

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const currentDistance = distanceByKey.get(positionKey(current)) ?? 0;
    for (const next of getDirectedNeighbors(state, current)) {
      const key = positionKey(next);
      if (distanceByKey.has(key)) continue;
      distanceByKey.set(key, currentDistance + 1);
      queue.push(next);
    }
  }

  return distanceByKey;
}

function nearestRedDistance(state, position) {
  if (!state.reds || state.reds.length === 0) return 0;
  if (state.__directedDistanceFields) {
    return distanceToNearestReachableRed(state, position);
  }
  const cached = state.__redDistanceMap?.get(positionKey(position));
  if (Number.isFinite(cached)) return cached;
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
  if (!green.package && config.emptyGreenFutureWeight <= EPSILON) return 0;
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
  const diagnostics = [];
  const entries = [...state.greens]
    .map((green) => {
      const reward = packageReward(green, config.meanPackageValue);
      const confidence = packageConfidence(green);
      if (!green.package || green.package.carriedBy) return null;
      if (reward <= 0) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance: Infinity,
          deliveryDistance: Infinity,
          estimatedDeliveredValue: 0,
          reachableFromMe: false,
          reachableRedAfterPickup: false,
          rejectionReason: "zero_reward"
        });
        return null;
      }
      if (confidence < config.minParcelConfidence) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance: Infinity,
          deliveryDistance: Infinity,
          estimatedDeliveredValue: 0,
          reachableFromMe: false,
          reachableRedAfterPickup: false,
          rejectionReason: "low_score"
        });
        return null;
      }

      const score = greenScores.get(green.id) ?? 0;
      const pickupDistance = distanceFromMe(state, green.position);
      const deliveryDistance = nearestRedDistance(state, green.position);
      const reachableFromMe = Number.isFinite(pickupDistance);
      const reachableRedAfterPickup = Number.isFinite(deliveryDistance);
      const estimatedDeliveredValue = reachableFromMe && reachableRedAfterPickup
        ? reward - packageDecayRate(green, config.decayRate) * (pickupDistance + deliveryDistance)
        : 0;

      if (!reachableFromMe || !reachableRedAfterPickup) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance,
          deliveryDistance,
          estimatedDeliveredValue,
          reachableFromMe,
          reachableRedAfterPickup,
          rejectionReason: reachableFromMe ? "no_reachable_red_after_pickup" : "unreachable_from_me"
        });
        return null;
      }

      const win = winProbability(state, green, pickupDistance, config);
      if (win <= EPSILON) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance,
          deliveryDistance,
          estimatedDeliveredValue,
          reachableFromMe,
          reachableRedAfterPickup,
          rejectionReason: "enemy_wins_race"
        });
        return null;
      }

      const priority = estimatedDeliveredValue / (1 + pickupDistance + deliveryDistance);
      return {
        green,
        score,
        priority,
        distanceFromMe: pickupDistance,
        distanceToRed: deliveryDistance,
        pickupDistance,
        deliveryDistance,
        estimatedDeliveredValue
      };
    })
    .filter(Boolean)
    .filter((entry) => Number.isFinite(entry.priority))
    .sort((a, b) => b.priority - a.priority || b.score - a.score || a.green.id.localeCompare(b.green.id));

  const maxCandidateGreens = Math.max(0, Math.round(asNumber(config.maxCandidateGreens, entries.length)));
  if (maxCandidateGreens === 0) {
    state.__candidateSelectionDiagnostics = diagnostics;
    return [];
  }

  const topGlobal = entries.slice(0, Math.max(0, Math.round(asNumber(config.topK, 0))));
  const localRadius = Math.max(0, asNumber(config.localCandidateRadius, DEFAULT_PARAMS.localCandidateRadius));
  const localLimit = Math.max(0, Math.round(asNumber(config.localCandidateLimit, DEFAULT_PARAMS.localCandidateLimit)));
  const clusterRadius = Math.max(
    0,
    asNumber(config.clusterExpansionRadius, asNumber(config.clusterPickupRadius, DEFAULT_PARAMS.clusterExpansionRadius))
  );
  const clusterLimit = Math.max(0, Math.round(asNumber(config.clusterExpansionLimit, DEFAULT_PARAMS.clusterExpansionLimit)));
  const selected = [];
  const selectedIds = new Set();

  const addEntry = (entry) => {
    if (!entry || selectedIds.has(entry.green.id)) return false;
    selectedIds.add(entry.green.id);
    selected.push(entry.green);
    return true;
  };

  for (const entry of topGlobal) addEntry(entry);

  if (localLimit > 0) {
    let added = 0;
    for (const entry of entries) {
      if (entry.distanceFromMe > localRadius) continue;
      if (addEntry(entry)) added += 1;
      if (added >= localLimit) break;
    }
  }

  if (clusterLimit > 0 && clusterRadius > 0) {
    let added = 0;
    for (const seed of topGlobal) {
      for (const entry of entries) {
        if (selectedIds.has(entry.green.id)) continue;
        const seedDistance = (state.__mapProfile?.hasDirectionalTiles)
          ? rankingDistance(state, seed.green.position, entry.green.position)
          : manhattan(seed.green.position, entry.green.position);
        if (!Number.isFinite(seedDistance) || seedDistance > clusterRadius) continue;
        if (addEntry(entry)) added += 1;
        if (added >= clusterLimit) break;
      }
      if (added >= clusterLimit) break;
    }
  }

  const result = selected.slice(0, maxCandidateGreens);
  const selectedSet = new Set(result.map((green) => green.id));
  for (const entry of entries) {
    if (selectedSet.has(entry.green.id)) continue;
    diagnostics.push({
      id: entry.green.id,
      position: copyPosition(entry.green.position),
      reward: packageReward(entry.green, config.meanPackageValue),
      confidence: packageConfidence(entry.green),
      pickupDistance: entry.pickupDistance,
      deliveryDistance: entry.deliveryDistance,
      estimatedDeliveredValue: entry.estimatedDeliveredValue,
      reachableFromMe: true,
      reachableRedAfterPickup: true,
      rejectionReason: "low_score"
    });
  }
  state.__candidateSelectionDiagnostics = diagnostics;
  return result;
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

export function buildPointsOfInterest(state, candidateGreens) {
  return [
    { id: "START", type: "start", position: copyPosition(state.me.position) },
    ...candidateGreens.map((green) => ({ ...green, type: "green", position: copyPosition(green.position) })),
    ...state.reds.map((red) => ({ ...red, type: "red", position: copyPosition(red.position) }))
  ];
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

function distanceFromMe(state, position) {
  const distance = directedDistanceFields(state).distFromMe.get(positionKey(position));
  return Number.isFinite(distance) ? distance : Infinity;
}

function distanceToNearestReachableRed(state, position) {
  if (!state.reds || state.reds.length === 0) return 0;
  const distance = directedDistanceFields(state).distToNearestRed.get(positionKey(position));
  return Number.isFinite(distance) ? distance : Infinity;
}

function reachableRedFromPosition(state, position) {
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

export function shortestGridPath(state, from, to, profile = null) {
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

function pathFromBfsAll(result, targetPosition) {
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

export function buildDistanceOracle(state, points) {
  const profile = buildMapProfile(state);
  const entries = new Map();
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const stats = {
    points: points.length,
    pathfindingCalls: 0,
    singleSourceBfsRuns: 0
  };

  if (profile.hasUniformCosts) {
    for (const from of points) {
      const all = bfsAllDistancesFrom(state, from.position);
      stats.singleSourceBfsRuns += 1;
      for (const to of points) {
        if (from.id === to.id) continue;
        const edge = pathFromBfsAll(all, to.position);
        entries.set(pairKey(from.id, to.id), {
          fromId: from.id,
          toId: to.id,
          cost: edge.cost,
          path: edge.path
        });
      }
    }
  } else {
    for (const from of points) {
      for (const to of points) {
        if (from.id === to.id) continue;
        stats.pathfindingCalls += 1;
        const edge = shortestGridPath(state, from.position, to.position, profile);
        entries.set(pairKey(from.id, to.id), {
          fromId: from.id,
          toId: to.id,
          cost: edge.cost,
          path: edge.path
        });
      }
    }
  }

  return { entries, points, pointsById, profile, stats };
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

export function finalObjective(plan, config) {
  return plan.deliveredScore - config.moveWeight * plan.moveCost;
}

export function bestCompletionValue(plan, reds, state, oracle, config) {
  if (plan.pickedPackages.length === 0) return finalObjective(plan, config);

  let best = -Infinity;
  for (const red of reds) {
    const edge = getOracleEdge(oracle, plan.currentId, red.id);
    if (!edge || !Number.isFinite(edge.cost)) continue;
    const deliveryTime = plan.time + edge.cost;
    const delivered = computeDeliveredValue(plan.pickedPackages, deliveryTime);
    const totalMoveCost = plan.moveCost + edge.cost;
    best = Math.max(best, plan.deliveredScore + delivered - config.moveWeight * totalMoveCost);
  }

  return Number.isFinite(best) ? best : finalObjective(plan, config);
}

export function estimateNearbyPackageBonus(plan, greens, state, oracle, config) {
  let bonus = 0;
  const radius = Math.max(0, asNumber(config.clusterPickupRadius, 0));
  const minValue = asNumber(config.minClusterPackageValue, 0);

  for (const green of greens) {
    if (plan.pickedGreenIds.has(green.id)) continue;
    if (!hasAvailablePackage(green, config)) continue;

    const edge = getOracleEdge(oracle, plan.currentId, green.id);
    if (!edge || !Number.isFinite(edge.cost) || edge.cost > radius) continue;

    const pickupTime = plan.time + edge.cost;
    const valueAtPickup = packageValueAtPickup(state, green, pickupTime, config);
    if (valueAtPickup < minValue) continue;

    const redDistance = nearestRedDistance(state, green.position);
    const decayRate = packageDecayRate(green, config.decayRate);
    const deliveryAwareValue = Math.max(
      0,
      valueAtPickup - (Number.isFinite(redDistance) ? decayRate * redDistance : 0)
    );
    const net = deliveryAwareValue - config.moveWeight * edge.cost;
    if (net > 0) bonus += net;
  }

  return bonus;
}

export function partialPlanPriority(plan, greens, reds, state, oracle, config) {
  return (
    bestCompletionValue(plan, reds, state, oracle, config) +
    config.clusterPickupBonusWeight * estimateNearbyPackageBonus(plan, greens, state, oracle, config)
  );
}

export function betterPlan(a, b, state, oracle, config) {
  if (!a) return b;
  if (!b) return a;

  const aValue = a.pickedPackages.length === 0 ? finalObjective(a, config) : planValue(a, state, oracle, config);
  const bValue = b.pickedPackages.length === 0 ? finalObjective(b, config) : planValue(b, state, oracle, config);
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

    nextBeam.sort(
      (a, b) =>
        partialPlanPriority(b, greens, reds, state, oracle, config) -
          partialPlanPriority(a, greens, reds, state, oracle, config) ||
        planValue(b, state, oracle, config) - planValue(a, state, oracle, config)
    );
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

  if (bestComplete) {
    return { ...bestComplete, value: planValue(bestComplete, state, oracle, config) };
  }

  if (bestPartial) {
    return {
      ...bestPartial,
      value: planValue(bestPartial, state, oracle, config),
      incomplete: true,
      needsDeliveryAfterPickup: true
    };
  }

  const failed = initialPlan(state);
  return {
    ...failed,
    value: planValue(failed, state, oracle, config),
    failed: true,
    failureReason: "no_valid_sequence"
  };
}

export function reconstructGridPath(sequence, oracle) {
  if (!Array.isArray(sequence) || sequence.length === 0) return [];
  const startPoint = oracle.pointsById.get(sequence[0]);
  const fullPath = startPoint ? [copyPosition(startPoint.position)] : [];

  for (let i = 0; i < sequence.length - 1; i += 1) {
    const edge = getOracleEdge(oracle, sequence[i], sequence[i + 1]);
    if (!edge || !Number.isFinite(edge.cost) || edge.path.length === 0) return [];
    const segment = i === 0 && fullPath.length === 0 ? edge.path : edge.path.slice(1);
    fullPath.push(...segment.map(copyPosition));
  }

  return fullPath;
}

const TARGET_PLAN_MODES = new Set(["PICKUP_DELIVERY", "DELIVERY_ONLY", "PICKUP_ONLY", "OPPORTUNISTIC_PICKUP"]);

function routePlanWouldHaveExecutableActions(routePlan) {
  if (!routePlan?.oracle || !Array.isArray(routePlan.sequence)) return false;

  for (let i = 0; i < routePlan.sequence.length - 1; i += 1) {
    const fromId = routePlan.sequence[i];
    const toId = routePlan.sequence[i + 1];
    const edge = getOracleEdge(routePlan.oracle, fromId, toId);
    const toPoint = routePlan.oracle.pointsById?.get(toId) ?? routePlan.oracle.points?.find((point) => point.id === toId);
    if (!edge || !toPoint) continue;
    if (Array.isArray(edge.path) && edge.path.length > 1) return true;
    if (toPoint.type === "green" && toPoint.package && !toPoint.noPickup) return true;
    if (toPoint.type === "red") return true;
  }

  return false;
}

function isInvalidNonIdleRoutePlan(routePlan) {
  if (!routePlan || !TARGET_PLAN_MODES.has(routePlan.mode)) return false;
  if (!Array.isArray(routePlan.sequence) || routePlan.sequence.length <= 1) return true;
  if (routePlan.sequence.length === 1 && routePlan.sequence[0] === "START") return true;
  if (!Array.isArray(routePlan.path) || routePlan.path.length === 0) return true;
  return !routePlanWouldHaveExecutableActions(routePlan);
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
  scoutTarget = null,
  invalidPlanDetected = false,
  fallbackStage = null,
  candidateDiagnostics = []
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
    pathIndex: 0,
    invalidPlanDetected,
    fallbackStage,
    candidateDiagnostics,
    hasDirectionalTiles: Boolean(profile?.hasDirectionalTiles),
    directedDistanceFieldsBuilt: Boolean(state.__directedDistanceFields)
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
  const routePlan = baseRoutePlan({
    mode: "DELIVERY_ONLY",
    sequence: bestPlan.sequence,
    path,
    value: planValue(bestPlan, state, oracle, config),
    plan: bestPlan,
    profile,
    config,
    greenScores,
    oracle,
    state,
    fallbackStage: "full_plan"
  });
  if (isInvalidNonIdleRoutePlan(routePlan)) return null;

  return routePlan;
}

function candidateRejectionReason(diagnostic) {
  if (!diagnostic.reachableFromMe) return "unreachable_from_me";
  if (diagnostic.reward <= 0 || diagnostic.valueAtPickup <= EPSILON) return "zero_reward";
  if (diagnostic.enemyBeatsUs) return "enemy_wins_race";
  if (!diagnostic.reachableRedAfterPickup) return "no_reachable_red_after_pickup";
  return "low_score";
}

function diagnoseCandidateGreens(state, candidateGreens, oracle, config) {
  return candidateGreens.map((green) => {
    const startEdge = getOracleEdge(oracle, "START", green.id);
    const pickupDistance = startEdge?.cost ?? distanceFromMe(state, green.position);
    const reachableFromMe = Number.isFinite(pickupDistance);
    const pickupTime = reachableFromMe ? asNumber(state.time, 0) + pickupDistance : Infinity;
    const valueAtPickup = reachableFromMe ? packageValueAtPickup(state, green, pickupTime, config) : 0;
    let bestGreenToRed = Infinity;

    for (const red of oracle.points.filter((point) => point.type === "red")) {
      const edge = getOracleEdge(oracle, green.id, red.id);
      if (edge && Number.isFinite(edge.cost)) bestGreenToRed = Math.min(bestGreenToRed, edge.cost);
    }

    if (!Number.isFinite(bestGreenToRed)) bestGreenToRed = nearestRedDistance(state, green.position);
    const deliveryDistance = bestGreenToRed;
    const reachableRedAfterPickup = Number.isFinite(deliveryDistance);
    const decayRate = packageDecayRate(green, config.decayRate);
    const estimatedDeliveredValue = reachableFromMe && reachableRedAfterPickup
      ? packageReward(green, config.meanPackageValue) - decayRate * (pickupDistance + deliveryDistance)
      : 0;
    const estimatedValueAtDelivery = reachableRedAfterPickup
      ? Math.max(0, valueAtPickup - decayRate * deliveryDistance)
      : 0;
    const enemyBeatsUs = reachableFromMe && !beatsEnemiesToGreen(state, green, pickupDistance, config);
    const diagnostic = {
      id: green.id,
      position: copyPosition(green.position),
      reward: packageReward(green, config.meanPackageValue),
      confidence: packageConfidence(green),
      pickupDistance,
      deliveryDistance,
      estimatedDeliveredValue,
      reachableFromMe,
      reachableRedAfterPickup,
      distanceStartToGreen: pickupDistance,
      startToGreenFinite: reachableFromMe,
      nearestRedDistance: deliveryDistance,
      greenToRedFinite: reachableRedAfterPickup,
      enemyBeatsUs,
      valueAtPickup,
      estimatedValueAtDelivery,
      rejectionReason: "unknown"
    };
    diagnostic.rejectionReason = candidateRejectionReason(diagnostic);
    return diagnostic;
  });
}

export function buildPickupOnlyPlan(state, candidateGreens, oracle, config, profile, greenScores) {
  let best = null;

  for (const green of candidateGreens) {
    if (!hasAvailablePackage(green, config)) continue;

    const edge = getOracleEdge(oracle, "START", green.id);
    if (!edge || !Number.isFinite(edge.cost) || edge.path.length === 0) continue;

    const pickupTime = asNumber(state.time, 0) + edge.cost;
    const valueAtPickup = packageValueAtPickup(state, green, pickupTime, config);
    if (valueAtPickup <= EPSILON) continue;

    const win = winProbability(state, green, edge.cost, config);
    const value = valueAtPickup * win - config.moveWeight * edge.cost;
    const pickupPlan = {
      ...initialPlan(state),
      sequence: ["START", green.id],
      currentId: green.id,
      currentPosition: copyPosition(green.position),
      time: pickupTime,
      moveCost: edge.cost,
      pickedPackages: [
        {
          greenId: green.id,
          packageId: String(green.package.id),
          valueAtPickup,
          pickupTime,
          decayRate: packageDecayRate(green, config.decayRate),
          confidence: packageConfidence(green)
        }
      ],
      pickedGreenIds: new Set([green.id]),
      deliveredScore: 0,
      value,
      incomplete: true,
      needsDeliveryAfterPickup: true
    };

    if (!best || value > best.value + EPSILON || (Math.abs(value - best.value) <= EPSILON && edge.cost < best.edge.cost)) {
      best = { green, edge, plan: pickupPlan, value };
    }
  }

  if (!best) return null;

  const routePlan = baseRoutePlan({
    mode: "PICKUP_ONLY",
    sequence: ["START", best.green.id],
    path: best.edge.path.map(copyPosition),
    value: best.value,
    plan: best.plan,
    profile,
    config,
    greenScores,
    candidateGreens,
    oracle,
    state,
    fallbackStage: "pickup_only"
  });

  return isInvalidNonIdleRoutePlan(routePlan) ? null : routePlan;
}

function buildPickupDeliveryPlan(state, profile, config, greenScores, candidateGreens) {
  const points = buildPointsOfInterest(state, candidateGreens);
  const oracle = buildDistanceOracle(state, points);
  const bestPlan = findBestSequence(state, points, oracle, greenScores, config);
  const path = reconstructGridPath(bestPlan.sequence, oracle);
  const routePlan = baseRoutePlan({
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
    state,
    invalidPlanDetected: Boolean(bestPlan.failed || bestPlan.incomplete),
    fallbackStage: "full_plan"
  });

  if (bestPlan.failed || bestPlan.incomplete || isInvalidNonIdleRoutePlan(routePlan)) {
    return {
      ...routePlan,
      invalidPlanDetected: true,
      failureReason: bestPlan.failureReason ?? (bestPlan.incomplete ? "incomplete_sequence" : "invalid_non_idle_plan")
    };
  }

  return routePlan;
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

function visibleAvailablePackages(state, config) {
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

function buildDenseGreenScoutPlan(state, profile, config, greenScores) {
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

function buildGreenExposureScoutPlan(state, profile, config, greenScores) {
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

function buildScoutPlan(state, profile, config, greenScores) {
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

function buildLocalExplorePlan(state, profile, config) {
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

export function replan(state) {
  const planningState = parseMap(state);
  const profile = buildMapProfile(planningState);
  Object.defineProperty(planningState, "__mapProfile", { value: profile, enumerable: false });
  Object.defineProperty(planningState, "__rankingDistanceCache", { value: new Map(), enumerable: false });
  Object.defineProperty(planningState, "__directedDistanceFields", {
    value: buildDirectedDistanceFields(planningState),
    enumerable: false
  });
  Object.defineProperty(planningState, "__redDistanceMap", {
    value: buildNearestRedDistanceMap(planningState, profile),
    enumerable: false
  });
  const config = chooseConfig(profile, planningState.params);
  const greenScores = computeGreenScores(planningState, config);
  const candidateGreens = selectCandidateGreens(planningState, greenScores, config);
  const selectionDiagnostics = planningState.__candidateSelectionDiagnostics ?? [];
  const visiblePackages = visibleAvailablePackages(planningState, config);
  let invalidPlanDetected = false;
  let candidateDiagnostics = selectionDiagnostics;

  if ((planningState.carriedPackages ?? []).length > 0) {
    const deliveryPlan = buildDeliveryOnlyPlan(planningState, profile, config, greenScores);
    if (deliveryPlan) return deliveryPlan;
  }

  if ((planningState.carriedPackages ?? []).length === 0 && candidateGreens.length > 0) {
    const fullPlan = buildPickupDeliveryPlan(planningState, profile, config, greenScores, candidateGreens);
    if (fullPlan && !fullPlan.invalidPlanDetected && !isInvalidNonIdleRoutePlan(fullPlan)) {
      return {
        ...fullPlan,
        candidateDiagnostics
      };
    }

    invalidPlanDetected = true;
    candidateDiagnostics = [
      ...selectionDiagnostics,
      ...diagnoseCandidateGreens(planningState, candidateGreens, fullPlan.oracle, config)
    ];
    const pickupOnlyPlan = buildPickupOnlyPlan(
      planningState,
      candidateGreens,
      fullPlan.oracle,
      config,
      profile,
      greenScores
    );
    if (pickupOnlyPlan) {
      return {
        ...pickupOnlyPlan,
        invalidPlanDetected,
        fallbackStage: "pickup_only",
        candidateDiagnostics
      };
    }
  }

  if (
    (planningState.carriedPackages ?? []).length === 0 &&
    candidateGreens.length === 0 &&
    visiblePackages.length === 0 &&
    profile.isDenseGreen
  ) {
    const denseScoutPlan = buildDenseGreenScoutPlan(planningState, profile, config, greenScores);
    if (denseScoutPlan) {
      return {
        ...denseScoutPlan,
        fallbackStage: "scout",
        candidateDiagnostics
      };
    }

    const localExplorePlan = buildLocalExplorePlan(planningState, profile, config);
    if (localExplorePlan) {
      return {
        ...localExplorePlan,
        fallbackStage: "local_explore",
        candidateDiagnostics
      };
    }

    return {
      ...buildIdlePlan(planningState, profile, config, greenScores),
      fallbackStage: "idle",
      candidateDiagnostics
    };
  }

  if (
    (planningState.carriedPackages ?? []).length === 0 &&
    candidateGreens.length === 0 &&
    planningState.greens.length > 0 &&
    visiblePackages.length === 0 &&
    (config.sensingRange <= 1 || profile.isMazeLike)
  ) {
    const exposurePlan = buildGreenExposureScoutPlan(planningState, profile, config, greenScores);
    if (exposurePlan) {
      return {
        ...exposurePlan,
        fallbackStage: "scout",
        candidateDiagnostics
      };
    }
  }

  const scoutPlan = buildScoutPlan(planningState, profile, config, greenScores);
  if (scoutPlan) {
    return {
      ...scoutPlan,
      invalidPlanDetected,
      fallbackStage: "scout",
      candidateDiagnostics
    };
  }

  const localExplorePlan = buildLocalExplorePlan(planningState, profile, config);
  if (localExplorePlan) {
    return {
      ...localExplorePlan,
      invalidPlanDetected,
      fallbackStage: "local_explore",
      candidateDiagnostics
    };
  }

  return {
    ...buildIdlePlan(planningState, profile, config, greenScores),
    invalidPlanDetected,
    fallbackStage: "idle",
    candidateDiagnostics
  };
}

export function directionFromPositions(from, to) {
  if (!from || !to) return null;
  if (to.x > from.x) return "right";
  if (to.x < from.x) return "left";
  if (to.y > from.y) return "up";
  if (to.y < from.y) return "down";
  return null;
}
