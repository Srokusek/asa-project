export function roundTilePosition(position) {
  return {
    x: Math.round(Number(position?.x ?? 0)),
    y: Math.round(Number(position?.y ?? 0))
  };
}

export function positionKey(position) {
  const p = roundTilePosition(position);
  return `${p.x},${p.y}`;
}

export function manhattan(a, b) {
  const pa = roundTilePosition(a);
  const pb = roundTilePosition(b);
  return Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
}

export function sameTile(a, b) {
  return positionKey(a) === positionKey(b);
}

export function isWithinSensingRange(a, b, range) {
  if (!Number.isFinite(range)) return false;
  return manhattan(a, b) <= range;
}

export function directionFromPositions(from, to) {
  const a = roundTilePosition(from);
  const b = roundTilePosition(to);
  if (b.x > a.x) return "right";
  if (b.x < a.x) return "left";
  if (b.y > a.y) return "up";
  if (b.y < a.y) return "down";
  return null;
}
