import { manhattan, positionKey, roundTilePosition } from "../utils/geometry.js";

function zoneIdFor(position, size) {
  const cell = roundTilePosition(position);
  return `Z_${Math.floor(cell.x / size)}_${Math.floor(cell.y / size)}`;
}

function emptyZone(id) {
  return {
    zoneId: id,
    lastVisitedTick: null,
    packagesSeen: 0,
    packagesPicked: 0,
    totalRewardSeen: 0,
    enemiesSeen: 0,
    lastUsefulTick: null,
    greenCount: 0,
    nearestRedDistance: Infinity,
    samplePosition: null
  };
}

function isVisibleParcel(parcel, beliefs) {
  if (!parcel || parcel.carriedBy) return false;
  return Number(parcel.confidence ?? 0) >= 1 || Number(parcel.lastSeenTime ?? -Infinity) >= Number(beliefs.time ?? 0);
}

export class ZoneMemory {
  constructor(config = {}) {
    this.config = config;
    this.zoneSize = Math.max(1, Number(config.zoneMemorySectorSize ?? config.coverageSectorSize ?? 5) || 5);
    this.zones = new Map();
    this.seenParcelIds = new Set();
    this.pickedParcelIds = new Set();
  }

  reset() {
    this.zones.clear();
    this.seenParcelIds.clear();
    this.pickedParcelIds.clear();
  }

  zoneFor(position) {
    const id = zoneIdFor(position, this.zoneSize);
    if (!this.zones.has(id)) this.zones.set(id, emptyZone(id));
    const zone = this.zones.get(id);
    if (!zone.samplePosition) zone.samplePosition = roundTilePosition(position);
    return zone;
  }

  updateFromBeliefs(beliefs) {
    if (!beliefs) return this.snapshot();
    const tick = Number(beliefs.time ?? 0);

    if (beliefs.me) {
      const zone = this.zoneFor(beliefs.me);
      zone.lastVisitedTick = tick;
      zone.samplePosition = roundTilePosition(beliefs.me);
    }

    const greenCountByZone = new Map();
    for (const tile of beliefs.tiles?.values?.() ?? []) {
      if (String(tile.type ?? "") !== "1") continue;
      const id = zoneIdFor(tile, this.zoneSize);
      greenCountByZone.set(id, (greenCountByZone.get(id) ?? 0) + 1);
      this.zoneFor(tile).greenCount = greenCountByZone.get(id);
    }

    for (const parcel of beliefs.parcels?.values?.() ?? []) {
      if (!isVisibleParcel(parcel, beliefs)) continue;
      const parcelId = String(parcel.id ?? positionKey(parcel));
      if (this.seenParcelIds.has(parcelId)) continue;
      this.seenParcelIds.add(parcelId);
      const zone = this.zoneFor(parcel);
      zone.packagesSeen += 1;
      zone.totalRewardSeen += Math.max(0, Number(parcel.rewardAtLastSeen ?? parcel.reward ?? 0));
      zone.lastUsefulTick = tick;
    }

    for (const parcel of beliefs.carriedParcels?.values?.() ?? []) {
      const parcelId = String(parcel.id ?? positionKey(parcel));
      if (this.pickedParcelIds.has(parcelId)) continue;
      this.pickedParcelIds.add(parcelId);
      const zone = this.zoneFor(parcel);
      zone.packagesPicked += 1;
      zone.lastUsefulTick = tick;
    }

    for (const enemy of beliefs.agents?.values?.() ?? []) {
      if (Number(enemy.confidence ?? 0) < 0.5) continue;
      const zone = this.zoneFor(enemy);
      zone.enemiesSeen += 1;
    }

    return this.snapshot();
  }

  scoreZones(plannerState) {
    const now = Number(plannerState?.time ?? 0);
    const start = plannerState?.me?.position ?? { x: 0, y: 0 };
    const redPositions = plannerState?.reds?.map((red) => red.position) ?? [];
    const rows = [];

    for (const zone of this.zones.values()) {
      const samplePosition = zone.samplePosition ?? start;
      const recentReward = zone.totalRewardSeen / Math.max(1, zone.packagesSeen);
      const staleness = zone.lastVisitedTick === null ? 100 : Math.max(0, now - zone.lastVisitedTick);
      const stalenessBonus = Math.min(100, staleness);
      const greenDensityBonus = zone.greenCount * 2;
      const enemyPressure = zone.enemiesSeen * 3;
      const travelCost = manhattan(start, samplePosition);
      const returnToRedCost =
        redPositions.length === 0
          ? 0
          : Math.min(...redPositions.map((red) => manhattan(samplePosition, red)));
      zone.nearestRedDistance = returnToRedCost;

      const score =
        recentReward +
        stalenessBonus +
        greenDensityBonus -
        enemyPressure -
        travelCost -
        Number(this.config.zoneMemoryReturnToRedWeight ?? 0.5) * returnToRedCost;

      rows.push({
        ...zone,
        score,
        recentReward,
        stalenessBonus,
        greenDensityBonus,
        enemyPressure,
        travelCost,
        returnToRedCost
      });
    }

    rows.sort((a, b) => b.score - a.score || a.travelCost - b.travelCost || a.zoneId.localeCompare(b.zoneId));
    return rows;
  }

  bestZone(plannerState) {
    return this.scoreZones(plannerState)[0] ?? null;
  }

  snapshot() {
    return {
      zoneSize: this.zoneSize,
      zones: [...this.zones.values()].map((zone) => ({ ...zone })),
      updatedAt: Date.now()
    };
  }

  static fromSnapshot(snapshot = {}, config = {}) {
    const memory = new ZoneMemory({ ...config, zoneMemorySectorSize: snapshot.zoneSize ?? config.zoneMemorySectorSize });
    for (const zone of snapshot.zones ?? []) {
      if (!zone?.zoneId) continue;
      memory.zones.set(zone.zoneId, { ...emptyZone(zone.zoneId), ...zone });
    }
    return memory;
  }
}

export { zoneIdFor };
