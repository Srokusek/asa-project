import { directionFromPositions } from "./route-planner.js";

function copyPosition(position) {
  return { x: Math.round(Number(position.x)), y: Math.round(Number(position.y)) };
}

function positionKey(position) {
  const p = copyPosition(position);
  return `${p.x},${p.y}`;
}

function getPoint(routePlan, id) {
  return routePlan.oracle?.pointsById?.get(id) ?? routePlan.oracle?.points?.find((point) => point.id === id) ?? null;
}

function getEdge(routePlan, fromId, toId) {
  return routePlan.oracle?.entries?.get(`${fromId}->${toId}`) ?? null;
}

function moveActionsForPath(path) {
  const actions = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const from = copyPosition(path[i]);
    const to = copyPosition(path[i + 1]);
    const direction = directionFromPositions(from, to);
    if (!direction) continue;
    actions.push({ type: "move", direction, from, to });
  }
  return actions;
}

function shouldPickUp(point) {
  return point?.type === "green" && point.package && !point.noPickup;
}

function actionsFromOracle(routePlan) {
  const actions = [];
  const picked = new Set();
  let putDownDone = false;

  for (let i = 0; i < routePlan.sequence.length - 1; i += 1) {
    const fromId = routePlan.sequence[i];
    const toId = routePlan.sequence[i + 1];
    const edge = getEdge(routePlan, fromId, toId);
    const toPoint = getPoint(routePlan, toId);

    if (!edge || !edge.path || edge.path.length === 0 || !toPoint) continue;
    actions.push(...moveActionsForPath(edge.path));

    if (shouldPickUp(toPoint) && !picked.has(toPoint.id)) {
      picked.add(toPoint.id);
      actions.push({
        type: "pick_up",
        at: copyPosition(toPoint.position),
        targetId: toPoint.id
      });
    }

    if (toPoint.type === "red" && !putDownDone) {
      putDownDone = true;
      actions.push({
        type: "put_down",
        at: copyPosition(toPoint.position),
        targetId: toPoint.id,
        parcels: "all"
      });
    }
  }

  return actions;
}

function actionsFromFlatPath(routePlan) {
  const actions = moveActionsForPath(routePlan.path ?? []);
  const picked = new Set();
  const sequencePoints = (routePlan.sequence ?? []).map((id) => getPoint(routePlan, id)).filter(Boolean);
  const greenByPosition = new Map(
    sequencePoints.filter(shouldPickUp).map((point) => [positionKey(point.position), point])
  );
  const redPoint = [...sequencePoints].reverse().find((point) => point.type === "red");

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const green = greenByPosition.get(positionKey(action.to));
    if (green && !picked.has(green.id)) {
      picked.add(green.id);
      actions.splice(i + 1, 0, { type: "pick_up", at: copyPosition(green.position), targetId: green.id });
      i += 1;
    }
  }

  if (redPoint && actions.some((action) => positionKey(action.to) === positionKey(redPoint.position))) {
    actions.push({
      type: "put_down",
      at: copyPosition(redPoint.position),
      targetId: redPoint.id,
      parcels: "all"
    });
  }

  return actions;
}

export function buildExecutablePlan(routePlan) {
  if (!routePlan || !Array.isArray(routePlan.sequence) || routePlan.sequence.length === 0) return [];
  if (routePlan.oracle?.entries && routePlan.oracle?.pointsById) return actionsFromOracle(routePlan);
  return actionsFromFlatPath(routePlan);
}
