import { positionKey, roundTilePosition } from "../utils/geometry.js";
import { parseMap } from "../planner/route-planner.js";

function tileAt(beliefs, x, y) {
  const tile = beliefs.tiles.get(`${x},${y}`);
  return tile ? { ...tile } : "0";
}

function tileType(tile) {
  return String(tile && typeof tile === "object" ? tile.type ?? "0" : tile ?? "0");
}

function activeParcelTileTask(task) {
  if (!task?.target) return null;
  const zoneTiles = Array.isArray(task.zoneTiles) && task.zoneTiles.length > 0
    ? task.zoneTiles.map((tile) => roundTilePosition(tile))
    : [roundTilePosition(task.target)];
  return {
    ...task,
    target: roundTilePosition(task.target),
    zoneTiles,
    ignoredParcelIds: Array.isArray(task.ignoredParcelIds)
      ? [...new Set(task.ignoredParcelIds.map((id) => String(id)).filter(Boolean))]
      : []
  };
}

function isBdiDeliveryTaskPickupSuppressed(parcel, deliveryTask, config) {
  if (config?.agentType !== "bdi" || !deliveryTask || !parcel) return false;
  return (deliveryTask.zoneTiles ?? []).some((tile) => positionKey(parcel) === positionKey(tile));
}

function occupiedTaskZoneKeys(beliefs, task, config) {
  if (!task) return new Set();
  const occupied = new Set();
  for (const agent of beliefs.agents.values()) {
    if (!agent || agent.id === beliefs.me?.id) continue;
    if (Number(agent.confidence ?? 0) < Number(config?.planner?.minParcelConfidence ?? 0)) continue;
    const key = positionKey(roundTilePosition(agent));
    if ((task.zoneTiles ?? []).some((tile) => positionKey(tile) === key)) {
      occupied.add(key);
    }
  }
  return occupied;
}

function preferredTaskZoneTiles(beliefs, task, config) {
  const zoneTiles = (task?.zoneTiles ?? []).map((tile) => ({ ...tile }));
  if (zoneTiles.length === 0) return [];
  const occupiedKeys = occupiedTaskZoneKeys(beliefs, task, config);
  const freeTiles = zoneTiles.filter((tile) => !occupiedKeys.has(positionKey(tile)));
  return freeTiles.length > 0 ? freeTiles : zoneTiles;
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

function activeOrchestrationRules(beliefs) {
  const rules = Array.isArray(beliefs?.orchestration?.rules) ? beliefs.orchestration.rules : [];
  if (rules.length === 0) return null;

  const activeRuleId = beliefs.orchestration.activeRuleId;
  if (!activeRuleId) {
    return {
      activeRuleId: null,
      rules
    };
  }

  const activeRule = rules.find((rule) => rule.id === activeRuleId);
  if (!activeRule) {
    return {
      activeRuleId: null,
      rules
    };
  }

  return {
    activeRuleId,
    rules: rules.filter((rule) => rule.dropoffPoiId === activeRule.dropoffPoiId)
  };
}

function orchestrationGreens(orchestration, beliefs, parcelsByPosition, config) {
  const greens = [];
  const seen = new Set();

  for (const rule of orchestration.rules) {
    for (const tile of rule.pickupTiles) {
      const position = roundTilePosition(tile);
      const key = positionKey(position);
      if (seen.has(key)) continue;
      seen.add(key);
      const best = bestParcelAt(beliefs, parcelsByPosition.get(key) ?? [], config);
      greens.push({
        id: `ORCHESTRATION_GREEN_${position.x}_${position.y}`,
        position,
        orchestrationRuleId: rule.id,
        pickupPoiId: rule.pickupPoiId,
        dropoffPoiId: rule.dropoffPoiId,
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
  }

  return greens;
}

function orchestrationReds(orchestration) {
  const reds = [];
  const seen = new Set();

  for (const rule of orchestration.rules) {
    for (const tile of rule.dropoffTiles) {
      const position = roundTilePosition(tile);
      const key = positionKey(position);
      if (seen.has(key)) continue;
      seen.add(key);
      reds.push({
        id: `ORCHESTRATION_RED_${position.x}_${position.y}`,
        position,
        dropoffPoiId: rule.dropoffPoiId
      });
    }
  }

  return reds;
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
  const pickupTileTask = activeParcelTileTask(beliefs?.parcelPickupTileTask);
  const deliveryTileTask = activeParcelTileTask(beliefs?.parcelDeliveryTileTask);
  const orchestration = activeOrchestrationRules(beliefs);
  const activeRoleTask = config?.agentType === "llm" ? pickupTileTask : config?.agentType === "bdi" ? deliveryTileTask : null;
  const ignoreDroppedDeliveryTileParcels = config?.agentType === "bdi" && deliveryTileTask;
  const preferredTaskTiles = preferredTaskZoneTiles(beliefs, activeRoleTask, config);

  //get the list of parcels from beliefs,
  // includes information such as location, reward, timeLastSeen, carriedBy, confidence etc.
  for (const parcel of beliefs.parcels.values()) {
    if (ignoreDroppedDeliveryTileParcels && beliefs.shouldIgnoreParcelForDeliveryTile?.(parcel.id)) continue;
    if (isBdiDeliveryTaskPickupSuppressed(parcel, deliveryTileTask, config)) continue;
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
    if (ignoreDroppedDeliveryTileParcels && beliefs.shouldIgnoreParcelForDeliveryTile?.(parcel.id)) continue;
    if (isBdiDeliveryTaskPickupSuppressed(parcel, deliveryTileTask, config)) continue;
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
        confidence: agent.confidence
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

  // return parsed map with all of the relevant information normalized
  const planningState = parseMap({
    width,
    height,
    grid,
    time: beliefs.time,
    meanPackageValue: beliefs.meanPackageValue,
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
    forbiddenTiles: Object.fromEntries(beliefs.forbiddenTiles ?? []),
    pickupTileMultipliers: Object.fromEntries(beliefs.pickupTileMultipliers ?? []),
    pickupTileBonuses: Object.fromEntries(beliefs.pickupTileBonuses ?? []),
    deliveryTileMultipliers: Object.fromEntries(beliefs.deliveryTileMultipliers ?? []),
    deliveryTileBonuses: Object.fromEntries(beliefs.deliveryTileBonuses ?? []),
    deliveryCountMultipliers: Object.fromEntries(beliefs.deliveryCountMultipliers ?? []),
    deliveryCountBonuses: Object.fromEntries(beliefs.deliveryCountBonuses ?? []),
    deliveryValueThresholdRule: beliefs.deliveryValueThresholdRule ? { ...beliefs.deliveryValueThresholdRule } : null,
    lastObservedAtByTile: Object.fromEntries(beliefs.lastObservedAtByTile ?? []),
    sensingRange: beliefs.sensingRange,
    params: {
      ...config.planner,
      sensingRange: beliefs.sensingRange
    }
  });

  if (pickupTileTask && config?.agentType === "llm") {
    planningState.greens = preferredTaskTiles.map((tile) => {
      const handoffBest = bestParcelAt(beliefs, parcelsByPosition.get(positionKey(tile)) ?? [], config);
      return {
        id: `HANDOFF_GREEN_${tile.x}_${tile.y}`,
        position: { ...tile },
        package: handoffBest
          ? {
              id: handoffBest.parcel.id,
              value: handoffBest.reward,
              reward: handoffBest.reward,
              carriedBy: handoffBest.parcel.carriedBy,
              decayRate: config.planner.decayRate,
              confidence: handoffBest.parcel.confidence,
              lastSeenTime: handoffBest.parcel.lastSeenTime
            }
          : null
      };
    });
  }

  if (deliveryTileTask && config?.agentType === "bdi") {
    planningState.reds = preferredTaskTiles.map((tile) => ({
      id: `HANDOFF_RED_${tile.x}_${tile.y}`,
      position: { ...tile }
    }));
  }

  if (orchestration) {
    planningState.greens = orchestrationGreens(orchestration, beliefs, parcelsByPosition, config);
    planningState.reds = orchestrationReds(orchestration);
    planningState.orchestration = {
      activeRuleId: orchestration.activeRuleId,
      rules: orchestration.rules.map((rule) => ({
        ...rule,
        pickupTiles: rule.pickupTiles.map((tile) => ({ ...tile })),
        dropoffTiles: rule.dropoffTiles.map((tile) => ({ ...tile }))
      }))
    };
  }

  Object.defineProperty(planningState, "__plannerStateNormalized", {
    value: true,
    enumerable: false
  });

  return planningState;
}
