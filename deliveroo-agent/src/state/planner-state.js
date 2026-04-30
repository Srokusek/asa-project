import { positionKey, roundTilePosition } from "../utils/geometry.js";

function tileAt(beliefs, x, y) {
  return beliefs.tiles.get(`${x},${y}`)?.type ?? "0";
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

export function buildPlannerState(beliefs, config) {
  const width = beliefs.width;
  const height = beliefs.height;
  const grid = [];
  const greens = [];
  const reds = [];
  const parcelsByPosition = new Map();

  for (const parcel of beliefs.parcels.values()) {
    const key = positionKey(parcel);
    const list = parcelsByPosition.get(key) ?? [];
    list.push(parcel);
    parcelsByPosition.set(key, list);
  }

  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const type = tileAt(beliefs, x, y);
      row.push(type);

      if (type === "1") {
        const position = { x, y };
        const best = bestParcelAt(beliefs, parcelsByPosition.get(positionKey(position)) ?? [], config);
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

  const carriedPackages = [...beliefs.carriedParcels.values()].map((parcel) => ({
    greenId: parcel.greenId ?? "CARRIED",
    packageId: parcel.id,
    valueAtPickup: Number(parcel.valueAtPickup ?? 0),
    pickupTime: Number(parcel.pickupTime ?? beliefs.time),
    decayRate: Number(parcel.decayRate ?? config.planner.decayRate),
    confidence: Number(parcel.confidence ?? 1)
  }));

  return {
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
    params: { ...config.planner }
  };
}
