import { directionFromPositions } from "../../utils/geometry.js";
import { normalizeSensingRange } from "../../state/belief-state.js";
import { DEFAULT_PARAMS } from "../default-params.js";

const EPSILON = 1e-9;

export function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(value, min, max) { //clamp value within a range
  return Math.max(min, Math.min(max, value));
}

export function positionKey(position) {
  return `${position.x},${position.y}`;
}

export function copyPosition(position) {
  return { x: Math.round(asNumber(position?.x)), y: Math.round(asNumber(position?.y)) };
}

function normalizeId(prefix, id, position) {
  if (id !== undefined && id !== null && String(id).length > 0) return String(id);
  return `${prefix}_${position.x}_${position.y}`;
}

function normalizeParams(input = {}) {
  return {
    ...DEFAULT_PARAMS,
    ...input,
    sensingRange: normalizeSensingRange(input?.sensingRange, DEFAULT_PARAMS.sensingRange)
  };
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
  /**
   * translate unicode for arrows on blue tiles to actual directions.
   */
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
  /**
   * normalize cell from observation into one of the expected categories to ensure observation compatibility.
   * blue cells with direction constraints also get translated to actual directions. we also collect any information
   * about restrictions for 
   */
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
    const directionConstraint = //what is the difference?? the direction constraint should work on both the entry and exit
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
      cost: blocked ? Infinity : Math.max(EPSILON, cost), // returns the cost depending on whether a direction is blocked or not
      directionConstraint: blocked ? null : directionConstraint,
      entryConstraint: blocked ? null : entryConstraint
    };
  }

  const value = String(raw ?? "normal").toLowerCase();
  // translate possible ways that tile types could be written
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
  // also normalize the directional tiles
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

  // unknown special cells stay traversable unless explicitly marked blocked
  return { type: "special", rawType: raw, blocked: false, cost: 1 };
}

function makeEmptyGrid(width, height, fill = "wall") { // generates an empty grid with height and width
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => normalizeCell(fill))
  );
}

function normalizeGrid(input, width, height) {
  if (Array.isArray(input?.grid)) { // if the input is a grid type:
    const inferredHeight = input.grid.length; 
    const inferredWidth = input.grid.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
    const finalWidth = asNumber(width, inferredWidth);
    const finalHeight = asNumber(height, inferredHeight);
    const grid = makeEmptyGrid(finalWidth, finalHeight, "wall"); // init as empty grid

    for (let y = 0; y < finalHeight; y += 1) {
      const row = input.grid[y] ?? [];
      for (let x = 0; x < finalWidth; x += 1) {
        grid[y][x] = normalizeCell(row[x] ?? "wall"); // fill in tile types in for loop
      }
    }
    return { grid, width: finalWidth, height: finalHeight };
  }

  if (Array.isArray(input?.tiles)) { // if the input is a tiles type:
    const maxX = input.tiles.reduce((max, tile) => Math.max(max, asNumber(tile.x, -1)), -1);
    const maxY = input.tiles.reduce((max, tile) => Math.max(max, asNumber(tile.y, -1)), -1);
    const finalWidth = Math.max(asNumber(width, input.width ?? 0), maxX + 1);
    const finalHeight = Math.max(asNumber(height, input.height ?? 0), maxY + 1);
    const grid = makeEmptyGrid(finalWidth, finalHeight, "wall"); // init empty grid

    for (const tile of input.tiles) {
      const x = Math.round(asNumber(tile.x));
      const y = Math.round(asNumber(tile.y));
      if (x >= 0 && y >= 0 && x < finalWidth && y < finalHeight) {
        grid[y][x] = normalizeCell(tile.type ?? tile.kind ?? tile); // fill in tile types in for loop
      }
    }
    return { grid, width: finalWidth, height: finalHeight };
  }

  // if input is neither tile nor grid type, return empty grid
  const finalWidth = asNumber(width, input?.width ?? 0);
  const finalHeight = asNumber(height, input?.height ?? 0);
  return { grid: makeEmptyGrid(finalWidth, finalHeight, "normal"), width: finalWidth, height: finalHeight };
}

function normalizeMe(input) { // ensure beliefs about me are in normal form
  const me = input.me ?? input.self ?? {};
  const position = me.position ?? me;
  return {
    ...me,
    position: copyPosition(position ?? { x: 0, y: 0 }) // round the position
  };
}

function normalizeEnemies(input, meId) { // ensure beliefs about enemies are in normal form
  const enemies = input.enemies ?? input.agents ?? [];
  return enemies
    .filter((enemy) => enemy && enemy.id !== meId)
    .map((enemy, index) => ({
      ...enemy,
      id: normalizeId("E", enemy.id ?? index, enemy.position ?? enemy),
      position: copyPosition(enemy.position ?? enemy)
    }));
}

function packageFromParcel(parcel, params) { // normalize package from map sensing? when does this happen??
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

function normalizePackage(pkg, params, fallbackId) { // normalize package from POI sensing
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

function collectPoisFromGrid(grid, type, prefix) { // find coords of specific coords of POIs, is there not a faster way to do this on a fixed map?
  const pois = [];
  for (let y = 0; y < grid.length; y += 1) {
    for (let x = 0; x < grid[y].length; x += 1) {
      if (grid[y][x].type === type) { // is a nested for loop really the best option?, maybe the impact is neglegible
        const position = { x, y };
        pois.push({ id: normalizeId(prefix, null, position), position });
      }
    }
  }
  return pois;
}

function uniqueByPosition(items) { // filter out duplicates by position uniqueness
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

function applyExplicitPoisToGrid(state) { //  not sure why we would need these explicit POIs, they should be within the grid itself
  for (const green of state.greens) {
    // dynamic parcels on non-green tiles (P_*) must not mutate static map topology.
    if (String(green.id ?? "").startsWith("P_")) continue;
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
    meanPackageValue: asNumber(input.meanPackageValue, params.meanPackageValue),
    me,
    enemies: normalizeEnemies(input, me.id),
    carriedPackages: (input.carriedPackages ?? []).map((pkg) => ({ ...pkg })),
    visitedGreenAt: normalizeVisitedGreenAt(input.visitedGreenAt),
    lastScoutTargetId: input.lastScoutTargetId ?? null,
    lastPosition: input.lastPosition ? copyPosition(input.lastPosition) : null,
    recentPositions: Array.isArray(input.recentPositions) ? input.recentPositions.map(copyPosition) : [],
    temporaryBlockedCells: input.temporaryBlockedCells ?? null,
    temporaryBlockedEdges: input.temporaryBlockedEdges ?? null,
    forbiddenTiles: normalizeObservationMap(input.forbiddenTiles),
    pickupTileMultipliers: normalizeObservationMap(input.pickupTileMultipliers),
    pickupTileBonuses: normalizeObservationMap(input.pickupTileBonuses),
    deliveryTileMultipliers: normalizeObservationMap(input.deliveryTileMultipliers),
    deliveryTileBonuses: normalizeObservationMap(input.deliveryTileBonuses),
    deliveryCountMultipliers: normalizeObservationMap(input.deliveryCountMultipliers),
    deliveryCountBonuses: normalizeObservationMap(input.deliveryCountBonuses),
    deliveryValueThresholdRule:
      input.deliveryValueThresholdRule && typeof input.deliveryValueThresholdRule === "object"
        ? { ...input.deliveryValueThresholdRule }
        : null,
    visitedPositions: normalizeObservationMap(input.visitedPositions),
    visitedEdges: normalizeObservationMap(input.visitedEdges),
    scoutTargetAttempts: normalizeObservationMap(input.scoutTargetAttempts),
    recentScoutTargets: Array.isArray(input.recentScoutTargets) ? input.recentScoutTargets.map(String) : [],
    lastDeliveryPosition: input.lastDeliveryPosition ? copyPosition(input.lastDeliveryPosition) : null,
    lastObservedAtByTile: normalizeObservationMap(input.lastObservedAtByTile),
    lastObservedAtByGreen: normalizeObservationMap(input.lastObservedAtByGreen),
    sensingRange: normalizeSensingRange(input.sensingRange, params.sensingRange),
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

export function edgeKey(from, to) {
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

function isForbiddenTile(state, position) {
  const key = positionKey(position);
  const forbidden = state.forbiddenTiles;
  if (!forbidden) return false;
  if (forbidden instanceof Map) return forbidden.has(key);
  if (Array.isArray(forbidden)) {
    return forbidden.some((entry) => positionKey(entry.position ?? entry) === key);
  }
  return Boolean(forbidden[key]);
}

export function isWalkable(state, position) {
  const cell = getCell(state, position);
  return !!cell && !cell.blocked && !isTemporarilyBlockedCell(state, position) && !isForbiddenTile(state, position);
}

export function isMoveAllowed(state, from, to) {
  const fromCell = getCell(state, from);
  const toCell = getCell(state, to);
  if (!fromCell || fromCell.blocked || !toCell || toCell.blocked) return false;
  if (isForbiddenTile(state, from) || isForbiddenTile(state, to)) return false;
  if (isTemporarilyBlockedCell(state, from) || isTemporarilyBlockedCell(state, to)) return false;
  if (isTemporarilyBlockedEdge(state, from, to)) return false;

  const direction = directionFromPositions(from, to);
  if (!direction) return false;

  if (fromCell.directionConstraint && fromCell.directionConstraint !== direction) return false;
  if (toCell.entryConstraint && toCell.entryConstraint !== direction) return false;
  return true;
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
  const obstacleDensity = totalCells > 0 ? obstacleCount / totalCells : 0;
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
    hasDecay,
    hasObstacles: obstacleCount > 0,
    hasDirectionalTiles: directionalConstraintCount > 0,
    hasDirectionalConstraints: directionalConstraintCount > 0,
    hasUniformCosts: nonUniformCostCount === 0
  };
}

export { directionConstraintFromValue, normalizeCell, makeEmptyGrid, normalizeGrid, normalizeMe, normalizeEnemies };
export { normalizeParams, normalizeVisitedGreenAt, normalizeObservationMap };
export { packageFromParcel, normalizePackage, collectPoisFromGrid, uniqueByPosition, applyExplicitPoisToGrid };
export { isTemporarilyBlockedCell, isTemporarilyBlockedEdge };
