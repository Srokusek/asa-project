function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeYouArgs(args) {
  if (args.length === 1 && typeof args[0] === "object") return args[0];
  const [id, name, x, y, score, penalty] = args;
  return { id, name, x, y, score, penalty };
}

function normalizeTileArgs(args) {
  if (args.length === 1 && typeof args[0] === "object") return args[0];
  const [x, y, third] = args;

  if (typeof third === "boolean") {
    return {
      x,
      y,
      type: third ? "2" : "3"
    };
  }

  return { x, y, type: third };
}

export function registerSdkListeners(socket, beliefs, _loop = null) {
  socket.on("connect", () => {
    beliefs.pushEvent("CONNECTED");
  });

  socket.on("disconnect", (reason) => {
    beliefs.pushEvent("DISCONNECTED", { reason });
  });

  socket.on("you", (...args) => {
    beliefs.updateSelf(normalizeYouArgs(args));
  });

  socket.on("map", (width, height, tiles) => {
    beliefs.updateMap(width, height, asArray(tiles));
  });

  socket.on("tile", (...args) => {
    beliefs.updateTile(normalizeTileArgs(args));
  });

  socket.on("agentsSensing", (agents = []) => {
    beliefs.updateAgentsSensing(asArray(agents));
  });

  socket.on("parcelsSensing", (parcels = []) => {
    const visible = beliefs.visiblePositionsFromSelf();
    beliefs.updateParcelsSensing(asArray(parcels), visible);
  });

  socket.on("sensing", (sensing = {}) => {
    beliefs.updateSensing({
      positions: asArray(sensing.positions),
      agents: asArray(sensing.agents),
      parcels: asArray(sensing.parcels),
      time: sensing.time
    });
  });
}
