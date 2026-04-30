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
  const [x, y, type] = args;
  return { x, y, type };
}

export function registerSdkListeners(socket, beliefs, _loop = null) {
  socket.on("connect", () => {
    beliefs.pushEvent("CONNECTED");
  });

  socket.on("disconnect", (reason) => {
    beliefs.pushEvent("DISCONNECTED", { reason });
  });

  socket.on("you", (...args) => {
    beliefs.updateTime();
    beliefs.updateSelf(normalizeYouArgs(args));
  });

  socket.on("map", (width, height, tiles) => {
    beliefs.updateTime();
    beliefs.updateMap(width, height, asArray(tiles));
  });

  socket.on("tile", (...args) => {
    beliefs.updateTime();
    beliefs.updateTile(normalizeTileArgs(args));
  });

  socket.on("agentsSensing", (agents = []) => {
    beliefs.updateTime();
    beliefs.updateAgentsSensing(asArray(agents));
  });

  socket.on("parcelsSensing", (parcels = []) => {
    beliefs.updateTime();
    beliefs.updateParcelsSensing(asArray(parcels));
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
