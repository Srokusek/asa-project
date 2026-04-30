import { directionFromPositions, positionKey, roundTilePosition } from "../utils/geometry.js";

function nowTime(fallback) {
  return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
}

function normalizeTileType(type) {
  const raw = String(type?.type ?? type ?? "0");
  if (raw === "0" || raw === "1" || raw === "2" || raw === "3") return raw;
  if (raw === "green" || raw === "parcel" || raw === "spawner") return "1";
  if (raw === "red" || raw === "delivery") return "2";
  if (raw === "normal" || raw === "walkable" || raw === "white" || raw === "4") return "3";
  return "0";
}

function eventPayload(type, payload) {
  return { type, payload, createdAt: Date.now() };
}

export class BeliefState {
  constructor(config) {
    this.config = config;
    this.time = 0;
    this.me = null;
    this.width = 0;
    this.height = 0;
    this.tiles = new Map();
    this.parcels = new Map();
    this.carriedParcels = new Map();
    this.agents = new Map();
    this.events = [];
    this.ready = false;
    this.dirty = true;
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
  }

  clearDirty() {
    this.dirty = false;
  }

  updateTime(optionalServerTime) {
    const serverTime = nowTime(optionalServerTime);
    this.time = serverTime ?? this.time + 1;
    this.decayUnseenAgents();
    return this.time;
  }

  updateReady() {
    this.ready = !!this.me && this.width > 0 && this.height > 0 && this.tiles.size > 0;
  }

  updateSelf(payload = {}) {
    const position = roundTilePosition(payload.position ?? payload);
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
    this.width = Number(width) || 0;
    this.height = Number(height) || 0;
    this.tiles.clear();

    for (const tile of tiles) {
      const position = roundTilePosition(tile);
      this.tiles.set(positionKey(position), {
        x: position.x,
        y: position.y,
        type: normalizeTileType(tile.type ?? tile)
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
    const normalized = {
      x: position.x,
      y: position.y,
      type: normalizeTileType(tile.type ?? typeOrDelivery)
    };
    this.tiles.set(positionKey(normalized), normalized);
    this.markDirty();
    this.pushEvent("TILE_UPDATED", normalized);
  }

  visiblePositionSet(visiblePositions = []) {
    return new Set(visiblePositions.map((position) => positionKey(position)));
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

  updateParcelsSensing(parcels = [], visiblePositions = []) {
    const seenIds = new Set();
    const visible = this.visiblePositionSet(visiblePositions);
    let invalidated = false;

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
