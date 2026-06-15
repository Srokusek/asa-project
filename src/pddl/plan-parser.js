function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function normalizeIdentifier(value, name) {
  const identifier = String(value ?? "").trim().toLowerCase();
  if (!identifier) {
    throw new TypeError(`${name} must be a non-empty identifier`);
  }
  return identifier;
}

function requireRuntimeAgentId(value, name) {
  const identifier = String(value ?? "").trim();
  if (!identifier) {
    throw new TypeError(`${name} must be a non-empty identifier`);
  }
  return identifier;
}

function copyTile(tile, name) {
  const x = Number(tile?.x);
  const y = Number(tile?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`${name} must contain finite x/y coordinates`);
  }
  return { x, y };
}

function resolveAgent(registry, pddlAgentId, sectorId) {
  const agent = registry.agents[pddlAgentId];
  if (!agent) {
    throw new Error(`unknown PDDL agent: ${pddlAgentId}`);
  }

  const registeredSectorId = normalizeIdentifier(
    agent.sectorId,
    `registry agent ${pddlAgentId} sectorId`
  );
  if (registeredSectorId !== sectorId) {
    throw new Error(
      `PDDL agent ${pddlAgentId} belongs to ${registeredSectorId}, not ${sectorId}`
    );
  }

  return {
    runtimeAgentId: requireRuntimeAgentId(
      agent.runtimeAgentId,
      `registry agent ${pddlAgentId} runtimeAgentId`
    )
  };
}

function resolvePoi(registry, poiId, sectorId, role) {
  const poi = registry.pois[poiId];
  if (!poi) {
    throw new Error(`unknown PDDL point of interest: ${poiId}`);
  }

  if (!Array.isArray(poi.sectors)) {
    throw new TypeError(`registry POI ${poiId} sectors must be an array`);
  }
  const sectors = poi.sectors.map((sector) =>
    normalizeIdentifier(sector, `registry POI ${poiId} sector`)
  );
  if (!sectors.includes(sectorId)) {
    throw new Error(`PDDL point of interest ${poiId} is not in sector ${sectorId}`);
  }

  const tiles = poi.tilesBySector?.[sectorId]?.[role] ?? poi.tiles;
  if (!Array.isArray(tiles) || tiles.length === 0) {
    throw new TypeError(
      `registry POI ${poiId} ${role} tiles for ${sectorId} must be a non-empty array`
    );
  }

  const resolved = {
    kind: normalizeIdentifier(poi.kind, `registry POI ${poiId} kind`),
    tiles: tiles.map((tile, index) =>
      copyTile(tile, `registry POI ${poiId} ${role} tile at index ${index}`)
    )
  };

  if (resolved.kind === "transfer") {
    resolved.idleTile = copyTile(
      poi.idleTiles?.[sectorId],
      `registry transfer POI ${poiId} idle tile for ${sectorId}`
    );
  }

  return resolved;
}

function parseAction(line, lineNumber) {
  const match = line.match(/^\(\s*([^\s()]+)(.*?)\)\s*$/);
  if (!match) {
    if (/\bset_rule\b/i.test(line)) {
      throw new Error(`malformed set_rule action on line ${lineNumber}`);
    }
    return null;
  }

  const action = match[1].toLowerCase();
  if (action !== "set_rule") return null;

  const rawParameters = match[2].trim();
  const parameters = rawParameters ? rawParameters.split(/\s+/) : [];
  if (
    parameters.length !== 4 ||
    parameters.some((parameter) => /[()]/.test(parameter))
  ) {
    throw new Error(
      `set_rule action on line ${lineNumber} must have exactly four parameters`
    );
  }

  return parameters.map((parameter) => parameter.toLowerCase());
}

export function parsePddlPlan(solutionPlan, registry) {
  if (typeof solutionPlan !== "string" || solutionPlan.trim().length === 0) {
    throw new TypeError("solutionPlan must be a non-empty string");
  }

  const normalizedRegistry = requireObject(registry, "registry");
  requireObject(normalizedRegistry.agents, "registry.agents");
  requireObject(normalizedRegistry.pois, "registry.pois");

  const rules = [];
  const rulesByAgentId = {};
  const lines = solutionPlan.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/;.*$/, "").trim();
    if (!line) continue;

    const parameters = parseAction(line, index + 1);
    if (!parameters) continue;

    const [pickupPoiId, dropoffPoiId, pddlAgentId, sectorId] = parameters;
    const agent = resolveAgent(normalizedRegistry, pddlAgentId, sectorId);
    const pickup = resolvePoi(normalizedRegistry, pickupPoiId, sectorId, "pickup");
    const dropoff = resolvePoi(normalizedRegistry, dropoffPoiId, sectorId, "dropoff");

    const rule = {
      id: `pddl:${pddlAgentId}:${pickupPoiId}:${dropoffPoiId}`,
      agentId: agent.runtimeAgentId,
      pddlAgentId,
      sectorId,
      pickupPoiId,
      dropoffPoiId,
      pickupTiles: pickup.tiles,
      dropoffTiles: dropoff.tiles,
      ...(pickup.idleTile ? { pickupIdleTile: pickup.idleTile } : {}),
      ...(dropoff.idleTile ? { dropoffIdleTile: dropoff.idleTile } : {})
    };

    rules.push(rule);
    if (!Object.hasOwn(rulesByAgentId, rule.agentId)) {
      rulesByAgentId[rule.agentId] = [];
    }
    rulesByAgentId[rule.agentId].push(rule);
  }

  if (rules.length === 0) {
    throw new Error("PDDL plan contains no set_rule actions");
  }

  return { rules, rulesByAgentId };
}
