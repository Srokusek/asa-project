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
  const raw = String(type ?? "0");
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

function chatPayload(message) {
  if (message && typeof message === "object") {
    return {
      ...message,
      fromId: message.fromId ?? message.id ?? message.from ?? null,
      fromName: message.fromName ?? message.name ?? null,
      text: String(message.text ?? message.msg ?? message.message ?? "")
    };
  }

  return { text: String(message ?? "") };
}

export class BeliefState {
  constructor(config) {
    this.config = config; // config with parameters for scoring etc.
    this.time = 0; // for time tracking
    this.version = 0; // for version history of beliefs
    this.me = null; // holds information about the agent itself
    this.width = 0; // map width
    this.height = 0; // map height
    this.tiles = new Map(); // location and types of tiles
    this.parcels = new Map(); // any observed parcels
    this.carriedParcels = new Map(); // any carried parcels
    this.agents = new Map(); // information about other agents
    this.temporaryBlockedCells = new Map(); // cells that are marked as blocked (another agent etc.)
    this.temporaryBlockedEdges = new Map(); // edges between cells that are marked as blocked (e.g. target cell is blocked)
    this.visitedPositions = new Map(); // keep track of positions visited by the agent
    this.visitedEdges = new Map(); // keep track of edges along which the agent has moved
    this.scoutTargetAttempts = new Map(); // keep track of how many times and when we attempted to scout a location
    this.recentScoutTargets = []; // recent targets chosen for scouting
    this.temporaryBlockVersion = 0; // to help keep track of when we initiated temporary blocks
    this.visitedGreenAt = new Map(); // keep track of when we visited a given green tile
    this.lastScoutTargetId = null;
    this.lastDeliveryPosition = null;
    this.lastPosition = null; // self position at previous belief state
    this.recentPositions = []; // list of recent posiitons
    this.lastObservedAtByTile = new Map(); // last observation of a given tile
    this.lastObservedAtByGreen = new Map(); // last observation of a given green tile
    this.chatInbox = []; // recent chat messages seen in Deliveroo.js
    this.chatSequence = 0;
    this.forbiddenTiles = new Map(); // sticky manually forbidden tiles overlay
    this.pickupTileMultipliers = new Map(); // sticky pickup-value multiplier by tile
    this.deliveryTileMultipliers = new Map(); // sticky delivery-value multiplier by tile
    this.deliveryCountMultipliers = new Map(); // sticky delivery-value multiplier by delivered package count
    this.manualTasks = [];
    this.manualTaskSequence = 0;
    this.events = [];
    this.ready = false; // mark that initial beliefs have been initiated
    this.dirty = true; // quickly note that something about the state has changed and should be reflected in planner
    this.lastWallClock = null; 
  }

  pushEvent(type, payload = {}) { // add an event payload to the events list, 
    this.events.push(eventPayload(type, payload));
  }

  pushChatMessage(message) {
    const entry = {
      chatId: ++this.chatSequence,
      ...chatPayload(message),
      receivedAt: Date.now()
    };

    this.chatInbox.push(entry);
    if (this.chatInbox.length > 50) {
      this.chatInbox.splice(0, this.chatInbox.length - 50);
    }

    this.markDirty();
    return entry;
  }

  pendingChatMessages(sinceChatId = 0, limit = 1) {
    const afterId = Math.max(0, Number(sinceChatId) || 0);
    const maxCount = Math.max(0, Number(limit) || 0);
    if (maxCount === 0) return [];
    return this.chatInbox.filter((message) => Number(message.chatId ?? 0) > afterId).slice(0, maxCount);
  }

  recentChatMessages(limit = 10) {
    const count = Math.max(0, Number(limit) || 0);
    if (count === 0) return [];
    return this.chatInbox.slice(-count);
  }

  pushManualTask(task = {}) {
    const ttl = Math.max(1, Number(task.expiresTicks ?? 30) || 30);
    const entry = {
      id: ++this.manualTaskSequence,
      type: String(task.type ?? "manual_task"),
      sourceChatId: Number(task.sourceChatId ?? 0) || null,
      senderId: task.senderId ?? null,
      createdAtTick: this.time,
      expiresAtTick: this.time + ttl,
      priority: String(task.priority ?? "override_once"),
      payload: task.payload ?? {}
    };
    this.manualTasks.push(entry);
    this.pushEvent("MANUAL_TASK_ADDED", {
      taskId: entry.id,
      taskType: entry.type,
      priority: entry.priority
    });
    this.markDirty();
    return entry;
  }

  setForbiddenTile(position, meta = {}) {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const current = this.forbiddenTiles.get(key);
    const entry = {
      x: cell.x,
      y: cell.y,
      reason: String(meta.reason ?? current?.reason ?? "manual_forbidden_tile"),
      sourceChatId: Number(meta.sourceChatId ?? current?.sourceChatId ?? 0) || null,
      senderId: meta.senderId ?? current?.senderId ?? null,
      createdAtTick: Number(current?.createdAtTick ?? this.time)
    };
    this.forbiddenTiles.set(key, entry);
    this.pushEvent("FORBIDDEN_TILE_ADDED", { ...entry });
    this.markDirty();
    return entry;
  }

  removeForbiddenTile(position, meta = {}) {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const existing = this.forbiddenTiles.get(key);
    if (!existing) return null;
    this.forbiddenTiles.delete(key);
    this.pushEvent("FORBIDDEN_TILE_REMOVED", {
      ...existing,
      removedAtTick: this.time,
      removedBy: meta.senderId ?? null,
      sourceChatId: Number(meta.sourceChatId ?? 0) || existing.sourceChatId || null
    });
    this.markDirty();
    return existing;
  }

  isForbiddenTile(position) {
    return this.forbiddenTiles.has(positionKey(roundTilePosition(position)));
  }

  listForbiddenTiles() {
    return [...this.forbiddenTiles.values()].map((tile) => ({ ...tile }));
  }

  setPickupTileMultiplier(position, multiplier, meta = {}) {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const factor = Number(multiplier);
    if (!Number.isFinite(factor) || factor <= 0) return null;
    const current = this.pickupTileMultipliers.get(key);
    const entry = {
      x: cell.x,
      y: cell.y,
      multiplier: factor,
      reason: String(meta.reason ?? current?.reason ?? "pickup_tile_multiplier"),
      sourceChatId: Number(meta.sourceChatId ?? current?.sourceChatId ?? 0) || null,
      senderId: meta.senderId ?? current?.senderId ?? null,
      createdAtTick: Number(current?.createdAtTick ?? this.time)
    };
    this.pickupTileMultipliers.set(key, entry);
    this.pushEvent("PICKUP_MULTIPLIER_SET", { ...entry });
    this.markDirty();
    return entry;
  }

  removePickupTileMultiplier(position, meta = {}) {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const existing = this.pickupTileMultipliers.get(key);
    if (!existing) return null;
    this.pickupTileMultipliers.delete(key);
    this.pushEvent("PICKUP_MULTIPLIER_REMOVED", {
      ...existing,
      removedAtTick: this.time,
      removedBy: meta.senderId ?? null,
      sourceChatId: Number(meta.sourceChatId ?? 0) || existing.sourceChatId || null
    });
    this.markDirty();
    return existing;
  }

  setDeliveryTileMultiplier(position, multiplier, meta = {}) {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const factor = Number(multiplier);
    if (!Number.isFinite(factor) || factor <= 0) return null;
    const current = this.deliveryTileMultipliers.get(key);
    const entry = {
      x: cell.x,
      y: cell.y,
      multiplier: factor,
      reason: String(meta.reason ?? current?.reason ?? "delivery_tile_multiplier"),
      sourceChatId: Number(meta.sourceChatId ?? current?.sourceChatId ?? 0) || null,
      senderId: meta.senderId ?? current?.senderId ?? null,
      createdAtTick: Number(current?.createdAtTick ?? this.time)
    };
    this.deliveryTileMultipliers.set(key, entry);
    this.pushEvent("DELIVERY_MULTIPLIER_SET", { ...entry });
    this.markDirty();
    return entry;
  }

  removeDeliveryTileMultiplier(position, meta = {}) {
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const existing = this.deliveryTileMultipliers.get(key);
    if (!existing) return null;
    this.deliveryTileMultipliers.delete(key);
    this.pushEvent("DELIVERY_MULTIPLIER_REMOVED", {
      ...existing,
      removedAtTick: this.time,
      removedBy: meta.senderId ?? null,
      sourceChatId: Number(meta.sourceChatId ?? 0) || existing.sourceChatId || null
    });
    this.markDirty();
    return existing;
  }

  setDeliveryCountMultiplier(count, multiplier, meta = {}) {
    const normalizedCount = Math.round(Number(count));
    const factor = Number(multiplier);
    if (!Number.isFinite(normalizedCount) || normalizedCount < 1) return null;
    if (!Number.isFinite(factor) || factor < 0) return null;
    const key = String(normalizedCount);
    const current = this.deliveryCountMultipliers.get(key);
    const entry = {
      count: normalizedCount,
      multiplier: factor,
      reason: String(meta.reason ?? current?.reason ?? "delivery_count_multiplier"),
      sourceChatId: Number(meta.sourceChatId ?? current?.sourceChatId ?? 0) || null,
      senderId: meta.senderId ?? current?.senderId ?? null,
      createdAtTick: Number(current?.createdAtTick ?? this.time)
    };
    this.deliveryCountMultipliers.set(key, entry);
    this.pushEvent("DELIVERY_COUNT_MULTIPLIER_SET", { ...entry });
    this.markDirty();
    return entry;
  }

  removeDeliveryCountMultiplier(count, meta = {}) {
    const normalizedCount = Math.round(Number(count));
    if (!Number.isFinite(normalizedCount) || normalizedCount < 1) return null;
    const key = String(normalizedCount);
    const existing = this.deliveryCountMultipliers.get(key);
    if (!existing) return null;
    this.deliveryCountMultipliers.delete(key);
    this.pushEvent("DELIVERY_COUNT_MULTIPLIER_REMOVED", {
      ...existing,
      removedAtTick: this.time,
      removedBy: meta.senderId ?? null,
      sourceChatId: Number(meta.sourceChatId ?? 0) || existing.sourceChatId || null
    });
    this.markDirty();
    return existing;
  }

  pickupMultiplierAt(position) {
    const key = positionKey(roundTilePosition(position));
    return Number(this.pickupTileMultipliers.get(key)?.multiplier ?? 1);
  }

  deliveryMultiplierAt(position) {
    const key = positionKey(roundTilePosition(position));
    return Number(this.deliveryTileMultipliers.get(key)?.multiplier ?? 1);
  }

  deliveryCountMultiplierFor(count) {
    const normalizedCount = Math.round(Number(count));
    if (!Number.isFinite(normalizedCount) || normalizedCount < 1) return 1;
    const key = String(normalizedCount);
    return Number(this.deliveryCountMultipliers.get(key)?.multiplier ?? 1);
  }

  clearExpiredManualTasks() {
    const previousLength = this.manualTasks.length;
    this.manualTasks = this.manualTasks.filter((task) => Number(task.expiresAtTick ?? -1) > this.time);
    if (this.manualTasks.length !== previousLength) this.markDirty();
  }

  peekManualTask() {
    this.clearExpiredManualTasks();
    return this.manualTasks[0] ?? null;
  }

  consumeManualTask() {
    this.clearExpiredManualTasks();
    const task = this.manualTasks.shift() ?? null;
    if (task) this.markDirty();
    return task;
  }


  consumeEvents() { // return recently collocted events and empty events list
    const events = this.events;
    this.events = [];
    return events;
  }

  markDirty() { // mark current belief state as "dirty" -> trigger to reflect in planner etc.
    this.dirty = true;
    this.version += 1;
  }

  clearDirty() { // undo "dirty" mark
    this.dirty = false;
  }

  updateTime(optionalServerTime) { // update belief time from server or locally if unavailable
    const serverTime = nowTime(optionalServerTime);
    if (serverTime === null) return this.time;
    this.time = serverTime;
    this.decayUnseenAgents(); // decay beliefs on unseen agents
    this.clearExpiredTemporaryBlocks(); // clear beliefs about temporarily blocked tiles which have expired (enough time has passed)
    this.clearExpiredTemporaryBlockedEdges(); // --||-- but for blocked edges
    this.clearExpiredManualTasks();
    return this.time;
  }

  advanceTime(ticks = 1) { // manually advance time by a tick amount
    const step = Math.max(0, Number(ticks) || 0);
    this.time += step;
    this.decayUnseenAgents(); // same belief decay as in previous functions
    this.clearExpiredTemporaryBlocks();
    this.clearExpiredTemporaryBlockedEdges();
    this.clearExpiredManualTasks();
    return this.time;
  }

  advanceTimeFromClock() { // use local time to advance time
    const now = Date.now();

    if (!this.lastWallClock) {
      this.lastWallClock = now;
      return this.time;
    }

    const tickMs = Number(this.config.planner.timeTickMs ?? 1000);
    const elapsedMs = now - this.lastWallClock;
    const ticks = Math.floor(elapsedMs / Math.max(1, tickMs)); // convert Ms to ticks based on config

    if (ticks > 0) {
      this.time += ticks;
      this.lastWallClock += ticks * Math.max(1, tickMs);
      this.decayUnseenAgents(); // same belief decay as in previous functions
      this.clearExpiredTemporaryBlocks();
      this.clearExpiredTemporaryBlockedEdges();
      this.clearExpiredManualTasks();
    }

    return this.time;
  }

  markTemporaryBlocked(position, ttlTicks = 3, reason = "move_failed") { 
    // mark a tile as blocked if move has failed
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    const current = this.temporaryBlockedCells.get(key);
    this.temporaryBlockedCells.set(key, {
      x: cell.x,
      y: cell.y,
      expiresAt: this.time + Math.max(1, Number(ttlTicks) || 1), // set expiry of blocked mark, default is 3 ticks
      reason,
      count: (current?.count ?? 0) + 1 // count how many times this tile was blocked
    });
    this.temporaryBlockVersion += 1;
    this.pushEvent("TEMPORARY_BLOCKED_CELL", { x: cell.x, y: cell.y, reason }); // push as event payload
    this.markDirty(); // mark belief state as dirty -> blocked tile needs to be considered in planner
  }

  edgeKey(from, to) {
    return `${positionKey(from)}->${positionKey(to)}`; // get key of edge between "from" and "to" tiles
  }

  markTemporaryBlockedEdge(from, to, ttlTicks = 2, reason = "move_failed") {
    // mark an edge between 2 tiles as temporarily blocked, overall similar to markTemporaryBlocked
    if (!from || !to) return;
    const fromCell = roundTilePosition(from);
    const toCell = roundTilePosition(to);
    const key = this.edgeKey(fromCell, toCell);
    const current = this.temporaryBlockedEdges.get(key);
    this.temporaryBlockedEdges.set(key, {
      key,
      from: fromCell,
      to: toCell,
      expiresAt: this.time + Math.max(1, Number(ttlTicks) || 1), // set temporary block expiry date, default 2 ticks
      reason,
      count: (current?.count ?? 0) + 1 // count how many times the edge has been temporarily blocked
    });
    this.temporaryBlockVersion += 1;
    this.pushEvent("TEMPORARY_BLOCKED_EDGE", { from: fromCell, to: toCell, reason }); // push as event payload
    this.markDirty();
  }

  clearExpiredTemporaryBlocks() { // clears temporary blocked tiles if they have expired
    let removed = false;
    for (const [key, block] of this.temporaryBlockedCells) { 
      if (block.expiresAt <= this.time) { // check expiries for tiles
        this.temporaryBlockedCells.delete(key);
        removed = true;
      }
    }
    if (removed) {
      this.temporaryBlockVersion += 1; // update version if we have made changes
      this.markDirty(); // mark dirty since planned should no longer consider tile as blocked
    }
  }

  clearExpiredTemporaryBlockedEdges() { // same as clearExpiredTemporaryBlocks but for edges
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

  isTemporarilyBlocked(position) { // check whether or not a given position is temporarily blocked
    const key = positionKey(position);
    const block = this.temporaryBlockedCells.get(key);
    return !!block && block.expiresAt > this.time; // True if blocked and not expired
  }

  isTemporarilyBlockedEdge(from, to) { // check whether or not a given position is temporarily blocked
    const block = this.temporaryBlockedEdges.get(this.edgeKey(from, to));
    return !!block && block.expiresAt > this.time; // True if blocked and not expired
  }

  markVisitedPosition(position, tick = this.time) { // save a position as visited along with time
    if (!position) return;
    this.visitedPositions.set(positionKey(roundTilePosition(position)), tick);
  }

  markVisitedEdge(from, to, tick = this.time) { // save edge as visited (passed) along with time
    if (!from || !to) return;
    this.visitedEdges.set(this.edgeKey(roundTilePosition(from), roundTilePosition(to)), tick);
  }

  markScoutTargetAttempt(targetId, tick = this.time) { // mark a target tile after attempting to scout it
    if (!targetId) return;
    const id = String(targetId);
    const current = this.scoutTargetAttempts.get(id);
    this.scoutTargetAttempts.set(id, {
      count: (current?.count ?? 0) + 1, // count number of attempts to scout give tile
      lastAttemptTick: tick
    });
    this.recentScoutTargets.push(id);
    this.recentScoutTargets = this.recentScoutTargets.slice(-8); // keep track only of last 8 recent scout attempts
    this.markDirty(); // mark dirty, this information is important for scouting plans
  }

  markScoutVisited(targetId, position = null) { // mark tile (only green tiles are scout targets) as visited by scouting
    if (!targetId) return;
    this.visitedGreenAt.set(String(targetId), this.time);
    this.lastScoutTargetId = String(targetId);
    this.pushEvent("SCOUT_TARGET_VISITED", { targetId: String(targetId), position }); // push as event payload
    this.markDirty(); // mark dirty, immportant for future scouting plans
  }

  greenRecentlyVisited(targetId, cooldownTicks) {
    const last = this.visitedGreenAt.get(String(targetId));
    return last !== undefined && this.time - last < cooldownTicks; // get list of greens visited within cooldownTicks
  }

  updateReady() {
    this.ready = !!this.me && this.width > 0 && this.height > 0 && this.tiles.size > 0; // update ready belief
  }

  updateSelf(payload = {}) { // coordinate and update all beliefs about self using payload received from server
    const position = roundTilePosition(payload.position ?? payload);
    const previousPosition = this.me ? { x: this.me.x, y: this.me.y } : null;
    if (previousPosition && positionKey(previousPosition) !== positionKey(position)) { // if position has changed...
      this.lastPosition = previousPosition;
      this.recentPositions.push(previousPosition);
      this.recentPositions = this.recentPositions.slice(-6); // only keep track of last 6 recent positions
      this.markVisitedEdge(previousPosition, position); // mark edge from "previous" to "current" as visited
    }
    this.markVisitedPosition(position);
    this.me = { // update beliefs about self
      id: String(payload.id ?? this.me?.id ?? ""),
      name: String(payload.name ?? this.me?.name ?? ""),
      x: position.x,
      y: position.y,
      score: Number(payload.score ?? this.me?.score ?? 0),
      penalty: Number(payload.penalty ?? this.me?.penalty ?? 0)
    };
    this.updateReady();
    this.markDirty(); // mark state as dirty to notify planner of change
    this.pushEvent("YOU_UPDATED", { me: this.me }); // push event about update
  }

  updateMap(width, height, tiles = []) { // update map, should only happen when loading new map
    // important: this does not consider tile events such as packages or agents, it is only the static features
    const dimensions = inferDimensions(width, height, tiles); // sometimes the information in the JSON is inaccurate
    this.width = dimensions.width;
    this.height = dimensions.height;
    this.tiles.clear();
    this.forbiddenTiles.clear();
    this.pickupTileMultipliers.clear();
    this.deliveryTileMultipliers.clear();
    this.deliveryCountMultipliers.clear();

    for (const tile of tiles) { // iteratively add tiles along with their type
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
    this.pushEvent("MAP_READY", { width: this.width, height: this.height }); // push event payload
  }

  updateTile(tileOrX, y, typeOrDelivery) { // update a type of tile on a map
    const tile =
      typeof tileOrX === "object" // accepts tile either as tile object or x y coords
        ? tileOrX
        : {
            x: tileOrX,
            y,
            type: typeOrDelivery // legacy for when True -> delivery point, False -> other type, now just use specific type
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
    this.pushEvent("TILE_UPDATED", normalized); // push event payload
  }

  visiblePositionSet(visiblePositions = []) {
    return new Set(visiblePositions.map((position) => positionKey(position)));
  }

  visiblePositionsFromSelf() { // get tiles which are visible from current position
    const range = Number(this.config.planner.sensingRange ?? 5); // use the config sensingRange, given by environment

    if (!this.me || !Number.isFinite(range)) return [];

    const visible = [];
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) { 
        const distance = Math.abs(x - this.me.x) + Math.abs(y - this.me.y); // compute Manhattan distance to all tiles
        if (distance <= range) visible.push({ x, y }); // set tiles as visible if within sensingRange
      }
    }

    return visible; // return list of visible tile coords
  }

  markObserved(position) { // mark a single tile as observed
    const cell = roundTilePosition(position);
    const key = positionKey(cell);
    this.lastObservedAtByTile.set(key, this.time); // mark last observed time as now

    const tile = this.tiles.get(key);
    if (tile?.type === "1") {
      this.lastObservedAtByGreen.set(key, this.time); // keep special track of green tiles
    }
  }

  markVisibleAreaObserved(visiblePositions = []) { // iterate marking as observed for a list of visible postions
    for (const position of visiblePositions) {
      this.markObserved(position);
    }
  }

  tileStaleness(position) { // compute "staleness" of a tile as a linear increase of time since last observed
    const last = this.lastObservedAtByTile.get(positionKey(position));
    if (last === undefined) return Infinity;
    return Math.max(0, this.time - last);
  }

  greenStaleness(position) { // same staleness computation, but for green tiles
    const last = this.lastObservedAtByGreen.get(positionKey(position));
    if (last === undefined) return Infinity;
    return Math.max(0, this.time - last);
  }

  estimateParcelReward(parcel, time = this.time) { // estimate the current reward of a parcel based on time since last observation
    if (!parcel) return 0;
    if (parcel.carriedBy) return 0;
    const elapsed = Math.max(0, Number(time) - Number(parcel.lastSeenTime));
    if (elapsed === 0) return Math.max(0, Number(parcel.rewardAtLastSeen ?? parcel.reward ?? 0));
    return Math.max(
      0,
      Number(parcel.rewardAtLastSeen ?? parcel.reward ?? 0) - // reward of parcel when seen
        Number(this.config.planner.decayRate ?? 0) * elapsed // use decayRate from config to determine how fast the reward decreases
    );
  }

  updateParcelsSensing(parcels = [], visiblePositions = null) { // update beliefs regarding parcels + mark visible tiles
    const actualVisiblePositions =
      Array.isArray(visiblePositions) && visiblePositions.length > 0
        ? visiblePositions
        : this.visiblePositionsFromSelf(); // use or calculate visible positions
    const seenIds = new Set();
    const visible = this.visiblePositionSet(actualVisiblePositions);
    let invalidated = false;
    this.markVisibleAreaObserved(actualVisiblePositions); // mark visible tiles as osberved

    for (const parcel of parcels) { // for each parcel...
      if (!parcel?.id) continue;
      const position = roundTilePosition(parcel.position ?? parcel);
      const previous = this.parcels.get(parcel.id);
      const carriedBy = parcel.carriedBy ?? null;
      const reward = Number(parcel.reward ?? parcel.value ?? 0);
      seenIds.add(parcel.id);

      this.parcels.set(parcel.id, { // save into belief state with...
        id: String(parcel.id), //... id
        x: position.x, //... location
        y: position.y,
        reward, //... reward
        rewardAtLastSeen: reward, // rewardAtLastSeen: reward since we just observed the parcel
        carriedBy, //... is currently carried?
        lastSeenTime: this.time, // lastSeenTime: now
        confidence: carriedBy ? 0 : 1 // confidence about availability of package, if carried -> 0, otherwise -> 1 (we see the package right now)
      });

      if (!previous && !carriedBy) { // push new package event if it was not seen before
        this.pushEvent("NEW_PACKAGE_SPAWN", { id: parcel.id, x: position.x, y: position.y }); 
      }
      if (carriedBy && previous && !previous.carriedBy) { // push package stolen event if another agent picked up the package
        this.pushEvent("PACKAGE_STOLEN", { id: parcel.id, carriedBy });
      }
    }

    for (const [id, parcel] of this.parcels) { // update parcels not currently seen, we use parcel id to match
      if (seenIds.has(id)) continue;
      if (parcel.carriedBy) { // if parcel is seen being carried by another agent, confidence = 0 
        parcel.confidence = 0;
        continue;
      }
      const key = positionKey(parcel);
      if (visible.has(key)) { // if we see location of parcel, but not parcel itself we assume it has dissapeared or stolen
        parcel.confidence = 0;
        parcel.carriedBy = parcel.carriedBy ?? "unknown";
        invalidated = true; // we no longer believe in existence of parcel
      } else { // otherwise, we decrease confidence based on when we last saw the package
        const dt = Math.max(1, this.time - parcel.lastSeenTime); 
        parcel.confidence = Math.exp(-Number(this.config.planner.beliefDecayRate ?? 0.08) * dt); // use beliefDecayRate from config to decrease confidence
        parcel.reward = this.estimateParcelReward(parcel); // recalculate reward as it decreases
      }
    }

    if (invalidated) this.pushEvent("BELIEF_INVALIDATED", { reason: "parcel_absent_in_visible_range" });
    this.pushEvent("PARCELS_SENSING", { count: parcels.length });
    this.markDirty(); // mark belief state as dirty for planner
  }

  updateAgentsSensing(agents = []) { // update beliefs regarding other agents
    const seenIds = new Set();

    for (const agent of agents) { // for each agent...
      if (!agent?.id || agent.id === this.me?.id) continue; //... ignore if me
      const position = roundTilePosition(agent.position ?? agent);
      const previous = this.agents.get(agent.id);
      const previousPosition = previous ? { x: previous.x, y: previous.y } : position; //... get previous position if we have it
      seenIds.add(agent.id);

      this.agents.set(agent.id, { // save into belief state with...
        id: String(agent.id), //... id
        name: String(agent.name ?? previous?.name ?? ""),
        x: position.x, //... location
        y: position.y,
        score: Number(agent.score ?? previous?.score ?? 0), //... score
        penalty: Number(agent.penalty ?? previous?.penalty ?? 0),
        lastSeenTime: this.time, //... lastSeenTime is now
        confidence: 1,
        previousX: previousPosition.x, //... previous position
        previousY: previousPosition.y,
        estimatedDirection: directionFromPositions(previousPosition, position) //... estimate direction based on previous location
      });
    }

    for (const [id, agent] of this.agents) {
      if (seenIds.has(id)) continue;
      const dt = Math.max(1, this.time - agent.lastSeenTime);
      agent.confidence = Math.exp(-Number(this.config.planner.beliefDecayRate ?? 0.08) * dt); // decay confidence in beliefs for unseen agents
    }

    this.pushEvent("AGENTS_SENSING", { count: agents.length });
    this.markDirty();
  }

  decayUnseenAgents() { // decay belief in unseen agents
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
