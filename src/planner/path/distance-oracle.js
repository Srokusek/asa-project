import { buildMapProfile, copyPosition } from "./grid-utils.js";
import { bfsAllDistancesFrom, pathFromBfsAll, shortestGridPath } from "./pathfinder.js";

function pairKey(fromId, toId) {
  return `${fromId}->${toId}`;
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
