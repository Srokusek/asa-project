import { directionFromPositions, positionKey, roundTilePosition } from "../utils/geometry.js";

function nowTime(fallback) {
  return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
}

function normalizeTileType(type) {
  const candidate =
    type && typeof type === "object"
      ? type.type ?? type.kind ?? type.tile ?? (typeof type.delivery === "boolean" ? type.delivery : undefined)
      : type;
  if (typeof candidate === "boolean") return candidate ? "2" : "3";
  const raw = String(candidate ?? "0");
  if (raw === "0" || raw === "1" || raw === "2" || raw === "3") return raw;
  if (raw === "green" || raw === "parcel" || raw === "spawner") return "1";
  if (raw === "red" || raw === "delivery") return "2";
  if (raw === "normal" || raw === "walkable" || raw === "white" || raw === "4") return "3";
  if (raw === "none" || raw === "wall" || raw === "blocked" || raw === "block") return "0";
  return raw;
}

function normalizeTileRecord(tileOrType, fallbackType = undefined) {
  const rawTile = tileOrType && typeof tileOrType === "object" ? tileOrType : { type: tileOrType ?? fallbackType };
  const normalized = {
    type: normalizeTileType(rawTile.type ?? rawTile.kind ?? rawTile.tile ?? fallbackType)
  };

  for (const key of ["directionConstraint", "entryConstraint", "blocked", "walkable", "cost", "moveCost"]) {
    if (rawTile[key] !== undefined) normalized[key] = rawTile[key];
  }

  return normalized;
}

function inferDimensions(width, height, tiles) {
  let maxX = -1;
  let maxY = -1;

  for (const tile of tiles) {
    maxX = Math.max(maxX, Number(tile.x ?? 0));
    maxY = Math.max(maxY, Number(tile.y ?? 0));
  }

  return {
    width: Math.max(Number(width) || 0, maxX + 1),
    height: Math.max(Number(height) || 0, maxY + 1)
  };
}

function eventPayload(type, payload) {
  return { type, payload, createdAt: Date.now() };
}

export class BeliefState {
  constructor(config) {
    this.config = config;
    this.time = 0;
    this.version = 0;
    this.me = null;
    this.width = 0;
    this.height = 0;
    this.tiles = new Map();
    this.parcels = new Map();
    this.carriedParcels = new Map();
    this.agents = new Map();
    this.temporaryBlockedCells = new Map();
    this.temporaryBlockedEdges = new Map();
    this.visitedPositions = new Map();
    this.visitedEdges = new Map();
    this.scoutTargetAttempts = new Map();
    this.recentScoutTargets = [];
    this.temporaryBlockVersion = 0;
    this.visitedGreenAt = new Map();
    this.lastScoutTargetId = null;
    this.lastDeliveryPosition = null;
    this.lastPosition = null;
    this.recentPositions = [];
    this.lastObservedAtByTile = new Map();
    this.lastObservedAtByGreen = new Map();
    this.events = [];
    this.ready = false;
    this.dirty = true;
    this.lastWallClock = null;
  }

  pushEvent(type, payload = {}) {
    this.events.push(eventPayload(type, payload));
  }

  consumeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  markDirty() {
    this.dirty = true;
    this.version += 1;
  }

  clearDirty() {
    this.dirty = false;
  }

  updateTime(optionalServerTime) {
    const serverTime = nowTime(optionalServerTime);
    if (serverTime === null) return this.time;
    this.time = serverTime;
    this.decayUnseenAgents();
    this.clearExpiredTemporaryBlocks();
    this.clearExpiredTemporaryBlockedEdges();
    return this.time;
  }

  advanceTime(ticks = 1) {
    const step = Math.max(0, Number(ticks) || 0);
    this.time += step;
    this.decayUnseenAgents();
    this.clearExpiredTemporaryBlocks();
    this.clearExpiredTemporaryBlockedEdges();
    return this.time;
  }

  advanceTimeFromClock() {
    const now = Date.now();

    if (!this.lastWallClock) {
      this.lastWallClock = now;
      return this.time;
    }

    const tickMs = Number(this.config.planner.timeTickMs ?? 1000);
    const elapsedMs = now - this.lastWallClock;
    const ticks = Math.floor(elapsedMs / Math.max(1, tickMs));

    if (ticks > 0) {
      this.time += ticks;
      this.lastWallClock += ticks * Math.max(1, tickMs);
      this.decayUnseenAgents();
      this.clearExpiredTemporaryBlocks();
      this.clearExpiredTemporaryBlockedEdges();
    }

    return this.time;
  }

  markTemporaryBlocked(position, ttlTicks = 3, reason = "move_failed") {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const current = this.temporaryBlockedCells.get(key);
    this.temporaryBlockedCells.set(key, {
      x: cell.x,
      y: cell.y,
      expiresAt: this.time + Math.max(1, Number(ttlTicks) || 1),
      reason,
      count: (current?.count ?? 0) + 1
    });
    this.temporaryBlockVersion += 1;
    this.pushEvent("TEMPORARY_BLOCKED_CELL", { x: cell.x, y: cell.y, reason });
    this.markDirty();
  }

  edgeKey(from, to) {
    return `${positionKey(from)}->${positionKey(to)}`;
  }

  markTemporaryBlockedEdge(from, to, ttlTicks = 2, reason = "move_failed") {
    if (!from || !to) return;
    const fromCell = roundTilePosition(from);
    const toCell = roundTilePosition(to);
    const key = this.edgeKey(fromCell, toCell);
    const current = this.temporaryBlockedEdges.get(key);
    this.temporaryBlockedEdges.set(key, {
      key,
      from: fromCell,
      to: toCell,
      expiresAt: this.time + Math.max(1, Number(ttlTicks) || 1),
      reason,
      count: (current?.count ?? 0) + 1
    });
    this.temporaryBlockVersion += 1;
    this.pushEvent("TEMPORARY_BLOCKED_EDGE", { from: fromCell, to: toCell, reason });
    this.markDirty();
  }

  clearExpiredTemporaryBlocks() {
    let removed = false;
    for (const [key, block] of this.temporaryBlockedCells) {
      if (block.expiresAt <= this.time) {
        this.temporaryBlockedCells.delete(key);
        removed = true;
      }
    }
    if (removed) {
      this.temporaryBlockVersion += 1;
      this.markDirty();
    }
  }

  clearExpiredTemporaryBlockedEdges() {
    let removed = false;
    for (const [key, block] of this.temporaryBlockedEdges) {
      if (block.expiresAt <= this.time) {
        this.temporaryBlockedEdges.delete(key);
        removed = true;
      }
    }
    if (removed) {
      this.temporaryBlockVersion += 1;
      this.markDirty();
    }
  }

  isTemporarilyBlocked(position) {
    const key = positionKey(position);
    const block = this.temporaryBlockedCells.get(key);
    return !!block && block.expiresAt > this.time;
  }

  isTemporarilyBlockedEdge(from, to) {
    const block = this.temporaryBlockedEdges.get(this.edgeKey(from, to));
    return !!block && block.expiresAt > this.time;
  }

  markVisitedPosition(position, tick = this.time) {
    if (!position) return;
    this.visitedPositions.set(positionKey(roundTilePosition(position)), tick);
  }

  markVisitedEdge(from, to, tick = this.time) {
    if (!from || !to) return;
    this.visitedEdges.set(this.edgeKey(roundTilePosition(from), roundTilePosition(to)), tick);
  }

  markScoutTargetAttempt(targetId, tick = this.time) {
    if (!targetId) return;
    const id = String(targetId);
    const current = this.scoutTargetAttempts.get(id);
    this.scoutTargetAttempts.set(id, {
      count: (current?.count ?? 0) + 1,
      lastAttemptTick: tick
    });
    this.recentScoutTargets.push(id);
    this.recentScoutTargets = this.recentScoutTargets.slice(-8);
    this.markDirty();
  }

  markScoutVisited(targetId, position = null) {
    if (!targetId) return;
    this.visitedGreenAt.set(String(targetId), this.time);
    this.lastScoutTargetId = String(targetId);
    this.pushEvent("SCOUT_TARGET_VISITED", { targetId: String(targetId), position });
    this.markDirty();
  }

  greenRecentlyVisited(targetId, cooldownTicks) {
    const last = this.visitedGreenAt.get(String(targetId));
    return last !== undefined && this.time - last < cooldownTicks;
  }

  updateReady() {
    this.ready = !!this.me && this.width > 0 && this.height > 0 && this.tiles.size > 0;
  }

  updateSelf(payload = {}) {
    const position = roundTilePosition(payload.position ?? payload);
    const previousPosition = this.me ? { x: this.me.x, y: this.me.y } : null;
    if (previousPosition && positionKey(previousPosition) !== positionKey(position)) {
      this.lastPosition = previousPosition;
      this.recentPositions.push(previousPosition);
      this.recentPositions = this.recentPositions.slice(-6);
      this.markVisitedEdge(previousPosition, position);
    }
    this.markVisitedPosition(position);
    this.me = {
      id: String(payload.id ?? this.me?.id ?? ""),
      name: String(payload.name ?? this.me?.name ?? ""),
      x: position.x,
      y: position.y,
      score: Number(payload.score ?? this.me?.score ?? 0),
      penalty: Number(payload.penalty ?? this.me?.penalty ?? 0)
    };
    this.updateReady();
    this.markDirty();
    this.pushEvent("YOU_UPDATED", { me: this.me });
  }

  updateMap(width, height, tiles = []) {
    const dimensions = inferDimensions(width, height, tiles);
    this.width = dimensions.width;
    this.height = dimensions.height;
    this.tiles.clear();

    for (const tile of tiles) {
      const position = roundTilePosition(tile);
      const normalizedTile = normalizeTileRecord(tile);
      this.tiles.set(positionKey(position), {
        x: position.x,
        y: position.y,
        ...normalizedTile
      });
    }

    this.updateReady();
    this.markDirty();
    this.pushEvent("MAP_READY", { width: this.width, height: this.height });
  }

  updateTile(tileOrX, y, typeOrDelivery) {
    const tile =
      typeof tileOrX === "object"
        ? tileOrX
        : {
            x: tileOrX,
            y,
            type: typeOrDelivery
          };
    const position = roundTilePosition(tile);
    const normalizedTile = normalizeTileRecord(tile, typeOrDelivery);
    const normalized = {
      x: position.x,
      y: position.y,
      ...normalizedTile
    };
    this.width = Math.max(this.width, normalized.x + 1);
    this.height = Math.max(this.height, normalized.y + 1);
    this.tiles.set(positionKey(normalized), normalized);
    this.updateReady();
    this.markDirty();
    this.pushEvent("TILE_UPDATED", normalized);
  }

  visiblePositionSet(visiblePositions = []) {
    return new Set(visiblePositions.map((position) => positionKey(position)));
  }

  visiblePositionsFromSelf() {
    const range = Number(this.config.planner.sensingRange ?? 5);

    if (!this.me || !Number.isFinite(range)) return [];

    const visible = [];
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const distance = Math.abs(x - this.me.x) + Math.abs(y - this.me.y);
        if (distance <= range) visible.push({ x, y });
      }
    }

    return visible;
  }

  markObserved(position) {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    this.lastObservedAtByTile.set(key, this.time);

    const tile = this.tiles.get(key);
    if (tile?.type === "1") {
      this.lastObservedAtByGreen.set(key, this.time);
    }
  }

  markVisibleAreaObserved(visiblePositions = []) {
    for (const position of visiblePositions) {
      this.markObserved(position);
    }
  }

  tileStaleness(position) {
    const last = this.lastObservedAtByTile.get(positionKey(position));
    if (last === undefined) return Infinity;
    return Math.max(0, this.time - last);
  }

  greenStaleness(position) {
    const last = this.lastObservedAtByGreen.get(positionKey(position));
    if (last === undefined) return Infinity;
    return Math.max(0, this.time - last);
  }

  estimateParcelReward(parcel, time = this.time) {
    if (!parcel) return 0;
    if (parcel.carriedBy) return 0;
    const elapsed = Math.max(0, Number(time) - Number(parcel.lastSeenTime));
    if (elapsed === 0) return Math.max(0, Number(parcel.rewardAtLastSeen ?? parcel.reward ?? 0));
    return Math.max(
      0,
      Number(parcel.rewardAtLastSeen ?? parcel.reward ?? 0) -
        Number(this.config.planner.decayRate ?? 0) * elapsed
    );
  }

  updateParcelsSensing(parcels = [], visiblePositions = null) {
    const actualVisiblePositions =
      Array.isArray(visiblePositions) && visiblePositions.length > 0
        ? visiblePositions
        : this.visiblePositionsFromSelf();
    const seenIds = new Set();
    const visible = this.visiblePositionSet(actualVisiblePositions);
    let invalidated = false;
    this.markVisibleAreaObserved(actualVisiblePositions);

    for (const parcel of parcels) {
      if (!parcel?.id) continue;
      const position = roundTilePosition(parcel.position ?? parcel);
      const previous = this.parcels.get(parcel.id);
      const carriedBy = parcel.carriedBy ?? null;
      const reward = Number(parcel.reward ?? parcel.value ?? 0);
      seenIds.add(parcel.id);

      this.parcels.set(parcel.id, {
        id: String(parcel.id),
        x: position.x,
        y: position.y,
        reward,
        rewardAtLastSeen: reward,
        carriedBy,
        lastSeenTime: this.time,
        confidence: carriedBy ? 0 : 1
      });

      if (!previous && !carriedBy) {
        this.pushEvent("NEW_PACKAGE_SPAWN", { id: parcel.id, x: position.x, y: position.y });
      }
      if (carriedBy && previous && !previous.carriedBy) {
        this.pushEvent("PACKAGE_STOLEN", { id: parcel.id, carriedBy });
      }
    }

    for (const [id, parcel] of this.parcels) {
      if (seenIds.has(id)) continue;
      if (parcel.carriedBy) {
        parcel.confidence = 0;
        continue;
      }
      const key = positionKey(parcel);
      if (visible.has(key)) {
        parcel.confidence = 0;
        parcel.carriedBy = parcel.carriedBy ?? "unknown";
        invalidated = true;
      } else {
        const dt = Math.max(1, this.time - parcel.lastSeenTime);
        parcel.confidence = Math.exp(-Number(this.config.planner.beliefDecayRate ?? 0.08) * dt);
        parcel.reward = this.estimateParcelReward(parcel);
      }
    }

    if (invalidated) this.pushEvent("BELIEF_INVALIDATED", { reason: "parcel_absent_in_visible_range" });
    this.pushEvent("PARCELS_SENSING", { count: parcels.length });
    this.markDirty();
  }

  updateAgentsSensing(agents = []) {
    const seenIds = new Set();

    for (const agent of agents) {
      if (!agent?.id || agent.id === this.me?.id) continue;
      const position = roundTilePosition(agent.position ?? agent);
      const previous = this.agents.get(agent.id);
      const previousPosition = previous ? { x: previous.x, y: previous.y } : position;
      seenIds.add(agent.id);

      this.agents.set(agent.id, {
        id: String(agent.id),
        name: String(agent.name ?? previous?.name ?? ""),
        x: position.x,
        y: position.y,
        score: Number(agent.score ?? previous?.score ?? 0),
        penalty: Number(agent.penalty ?? previous?.penalty ?? 0),
        lastSeenTime: this.time,
        confidence: 1,
        previousX: previousPosition.x,
        previousY: previousPosition.y,
        estimatedDirection: directionFromPositions(previousPosition, position)
      });
    }

    for (const [id, agent] of this.agents) {
      if (seenIds.has(id)) continue;
      const dt = Math.max(1, this.time - agent.lastSeenTime);
      agent.confidence = Math.exp(-Number(this.config.planner.beliefDecayRate ?? 0.08) * dt);
    }

    this.pushEvent("AGENTS_SENSING", { count: agents.length });
    this.markDirty();
  }

  decayUnseenAgents() {
    for (const agent of this.agents.values()) {
      if (agent.lastSeenTime >= this.time) continue;
      const dt = Math.max(1, this.time - agent.lastSeenTime);
      agent.confidence = Math.exp(-Number(this.config.planner.beliefDecayRate ?? 0.08) * dt);
    }
  }

  updateSensing(sensing = {}) {
    this.updateTime(sensing.time);
    this.updateAgentsSensing(sensing.agents ?? []);
    this.updateParcelsSensing(sensing.parcels ?? [], sensing.positions ?? []);
  }
}
