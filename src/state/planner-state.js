import { positionKey, roundTilePosition } from "../utils/geometry.js";
import { parseMap } from "../planner/route-planner.js";

function tileAt(beliefs, x, y) {
  const tile = beliefs.tiles.get(`${x},${y}`);
  return tile ? { ...tile } : "0";
}

function tileType(tile) {
  return String(tile && typeof tile === "object" ? tile.type ?? "0" : tile ?? "0");
}

function parcelAvailableForPlanning(beliefs, parcel, config) {
  if (!parcel || parcel.carriedBy) return false;
  if (parcel.confidence < config.planner.minParcelConfidence) return false;
  return beliefs.estimateParcelReward(parcel) > 0;
}

function bestParcelAt(beliefs, parcels, config) {
  let best = null;
  let bestScore = -Infinity;
  for (const parcel of parcels) {
    if (!parcelAvailableForPlanning(beliefs, parcel, config)) continue;
    const reward = beliefs.estimateParcelReward(parcel);
    const score = reward * parcel.confidence;
    if (score > bestScore) {
      best = { parcel, reward };
      bestScore = score;
    }
  }
  return best;
}

function inferBoundsFromTiles(beliefs) {
  let maxX = Math.max(0, beliefs.width - 1);
  let maxY = Math.max(0, beliefs.height - 1);

  for (const tile of beliefs.tiles.values()) {
    maxX = Math.max(maxX, Number(tile.x));
    maxY = Math.max(maxY, Number(tile.y));
  }

  return {
    width: maxX + 1,
    height: maxY + 1
  };
}

function objectFromMap(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  return {};
}

function mergeRuleObjects(...sources) {
  return Object.assign({}, ...sources.map(objectFromMap));
}

export function buildPlannerState(beliefs, config) {
  // initiate objects for general information about the environment
  const bounds = inferBoundsFromTiles(beliefs);
  const width = bounds.width;
  const height = bounds.height;
  const grid = [];
  const greens = [];
  const reds = [];
  const parcelsByPosition = new Map();
  const greenPositions = new Set();

  //get the list of parcels from beliefs,
  // includes information such as location, reward, timeLastSeen, carriedBy, confidence etc.
  for (const parcel of beliefs.parcels.values()) {
    const key = positionKey(parcel);
    const list = parcelsByPosition.get(key) ?? [];
    list.push(parcel);
    parcelsByPosition.set(key, list);
  }

  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      // keep the static map topology unchanged; temporary blocks are enforced via overlays.
      const tile = tileAt(beliefs, x, y);
      const type = tileType(tile);
      row.push(tile);
    
      // if the tile is a green tile:
      if (type === "1") {
        const position = { x, y };
        // we only take the best package at a tile, not the best in case one tile has more than one package
        const best = bestParcelAt(beliefs, parcelsByPosition.get(positionKey(position)) ?? [], config);
        greenPositions.add(positionKey(position));
        // push the green tiles information into the greens list, including present packages
        greens.push({
          id: `G_${x}_${y}`,
          position,
          package: best
            ? {
                id: best.parcel.id,
                value: best.reward,
                reward: best.reward,
                carriedBy: best.parcel.carriedBy,
                decayRate: config.planner.decayRate,
                confidence: best.parcel.confidence,
                lastSeenTime: best.parcel.lastSeenTime
              }
            : null
        });
      }

      if (type === "2") {
        reds.push({ id: `R_${x}_${y}`, position: { x, y } });
      }
    }
    grid.push(row);
  }

  // keep track of parcels seperately, this is important since otherwise we only consider
  // parcels at green tiles!
  for (const parcel of beliefs.parcels.values()) {
    // ignore parcels carried by other agents or with low confidence
    if (!parcelAvailableForPlanning(beliefs, parcel, config)) continue;

    const position = { x: Number(parcel.x), y: Number(parcel.y) };
    const key = positionKey(position);
    // if the parcel is on a green tile, ignore this parcel as it has been noted
    // in the greens object already
    if (greenPositions.has(key)) continue;
    // also ignore if the position is blocked for some reason
    if (beliefs.isTemporarilyBlocked?.(position)) continue;
    if (tileType(tileAt(beliefs, position.x, position.y)) === "0") continue;

    const reward = beliefs.estimateParcelReward(parcel);
    // add the parcel to the greens list, the "P_..." id identifies that it is a "stray" parcel
    greens.push({
      id: `P_${parcel.id}`,
      position,
      package: {
        id: parcel.id,
        value: reward,
        reward,
        carriedBy: parcel.carriedBy,
        decayRate: config.planner.decayRate,
        confidence: parcel.confidence,
        lastSeenTime: parcel.lastSeenTime
      }
    });
    greenPositions.add(key);
  }

  // collect information about me and other agents
  const mePosition = roundTilePosition(beliefs.me ?? { x: 0, y: 0 });
  const enemies = [...beliefs.agents.values()]
    .filter((agent) => agent.id !== beliefs.me?.id && agent.confidence >= config.planner.minParcelConfidence)
    .map((agent) => {
      const position = roundTilePosition(agent);
      return {
        id: agent.id,
        name: agent.name,
        position,
        score: agent.score,
        penalty: agent.penalty,
        confidence: agent.confidence,
        speed: 1
      };
    });

  // collect information about packages the agent itself is currently carrying
  const carriedPackages = [...beliefs.carriedParcels.values()].map((parcel) => ({
    greenId: parcel.greenId ?? "CARRIED",
    pickupSourceId:
      parcel.pickupSourceId ??
      `L_${Number(parcel.x ?? beliefs.me?.x ?? 0)}_${Number(parcel.y ?? beliefs.me?.y ?? 0)}`,
    packageId: parcel.id,
    valueAtPickup: Number(parcel.valueAtPickup ?? 0),
    pickupTime: Number(parcel.pickupTime ?? beliefs.time),
    decayRate: Number(parcel.decayRate ?? config.planner.decayRate),
    confidence: Number(parcel.confidence ?? 1),
    pickupPosition: {
      x: Number(parcel.x ?? beliefs.me?.x ?? 0),
      y: Number(parcel.y ?? beliefs.me?.y ?? 0)
    }
  }));

  beliefs.missionRegistry?.expireMissions?.(beliefs.time);
  const missionSpecs = beliefs.missionRegistry?.activeMissions?.(beliefs.time) ?? [];
  const deliveryRules = beliefs.missionRegistry?.activeDeliveryRules?.(beliefs.time) ?? {};
  const missionForbiddenTiles = beliefs.missionRegistry?.activeForbiddenTiles?.(beliefs.time) ?? {};

  // return parsed map with all of the relevant information normalized
  return parseMap({
    width,
    height,
    grid,
    time: beliefs.time,
    me: {
      id: beliefs.me?.id ?? "",
      name: beliefs.me?.name ?? "",
      score: beliefs.me?.score ?? 0,
      penalty: beliefs.me?.penalty ?? 0,
      position: mePosition
    },
    enemies,
    carriedPackages,
    greens,
    reds,
    visitedGreenAt: Object.fromEntries(beliefs.visitedGreenAt ?? []),
    lastScoutTargetId: beliefs.lastScoutTargetId,
    lastPosition: beliefs.lastPosition,
    recentPositions: beliefs.recentPositions,
    temporaryBlockedCells: Object.fromEntries(beliefs.temporaryBlockedCells ?? []),
    temporaryBlockedEdges: Object.fromEntries(beliefs.temporaryBlockedEdges ?? []),
    visitedPositions: Object.fromEntries(beliefs.visitedPositions ?? []),
    visitedEdges: Object.fromEntries(beliefs.visitedEdges ?? []),
    scoutTargetAttempts: Object.fromEntries(beliefs.scoutTargetAttempts ?? []),
    recentScoutTargets: beliefs.recentScoutTargets,
    lastDeliveryPosition: beliefs.lastDeliveryPosition,
    forbiddenTiles: mergeRuleObjects(beliefs.forbiddenTiles, missionForbiddenTiles),
    missionSpecs,
    deliveryRules,
    deliveryDecision: beliefs.deliveryDecision ?? null,
    pickupTileMultipliers: mergeRuleObjects(beliefs.pickupTileMultipliers, deliveryRules.pickupTileMultipliers),
    deliveryTileMultipliers: mergeRuleObjects(beliefs.deliveryTileMultipliers, deliveryRules.deliveryTileMultipliers),
    deliveryCountMultipliers: mergeRuleObjects(beliefs.deliveryCountMultipliers, deliveryRules.deliveryCountMultipliers),
    stackRules: Array.isArray(deliveryRules.stackRules) ? deliveryRules.stackRules : [],
    stackRuleConflicts: Array.isArray(deliveryRules.stackRuleConflicts) ? deliveryRules.stackRuleConflicts : [],
    teamState: beliefs.teamState ?? {},
    zoneMemory: beliefs.zoneMemorySummary ?? null,
    lastObservedAtByTile: Object.fromEntries(beliefs.lastObservedAtByTile ?? []),
    lastObservedAtByGreen: Object.fromEntries(beliefs.lastObservedAtByGreen ?? []),
    sensingRange: config.planner.sensingRange,
    params: { ...config.planner }
  });
}
