import { buildPlannerState } from "../state/planner-state.js";
import { copyPosition, isWalkable, positionKey } from "../planner/path/grid-utils.js";

const VALID_EXTREMES = new Set(["leftmost", "rightmost", "topmost", "bottommost"]);
const VALID_SCOPES = new Set(["pickup", "delivery", "walkable"]);

function uniquePositions(positions = []) {
  const seen = new Set();
  const unique = [];
  for (const position of positions) {
    const normalized = copyPosition(position);
    const key = positionKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function compareByExtreme(extreme, a, b) {
  if (extreme === "leftmost") return a.x - b.x || a.y - b.y || a.x - b.x;
  if (extreme === "rightmost") return b.x - a.x || a.y - b.y || a.x - b.x;
  if (extreme === "topmost") return a.y - b.y || a.x - b.x || a.y - b.y;
  return b.y - a.y || a.x - b.x || a.y - b.y;
}

export function selectorCandidatesForScope(state, scope) {
  if (!VALID_SCOPES.has(scope)) return [];

  if (scope === "delivery") {
    return uniquePositions((state.reds ?? []).map((red) => red.position).filter((position) => isWalkable(state, position)));
  }

  if (scope === "pickup") {
    return uniquePositions((state.greens ?? []).map((green) => green.position).filter((position) => isWalkable(state, position)));
  }

  const positions = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const position = { x, y };
      if (isWalkable(state, position)) positions.push(position);
    }
  }
  return positions;
}

export function resolveTileSelectorFromState(state, selector = {}) {
  const extreme = String(selector?.extreme ?? "").trim().toLowerCase();
  const scope = String(selector?.scope ?? "").trim().toLowerCase();
  if (!VALID_EXTREMES.has(extreme)) {
    return { ok: false, reason: "invalid_selector_extreme", details: { selector } };
  }
  if (!VALID_SCOPES.has(scope)) {
    return { ok: false, reason: "invalid_selector_scope", details: { selector } };
  }

  const candidates = selectorCandidatesForScope(state, scope);
  if (candidates.length === 0) {
    return { ok: false, reason: "selector_no_candidates", details: { selector: { extreme, scope } } };
  }

  const sorted = [...candidates].sort((a, b) => compareByExtreme(extreme, a, b));
  return {
    ok: true,
    target: sorted[0],
    selector: { extreme, scope },
    candidateCount: candidates.length
  };
}

export function resolveTileSelector({ beliefs, config, selector }) {
  const state = buildPlannerState(beliefs, config);
  return resolveTileSelectorFromState(state, selector);
}
