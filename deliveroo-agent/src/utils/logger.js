const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function enabled(name) {
    return (LEVELS[name] ?? LEVELS.info) >= threshold;
  }

  return {
    debug: (...args) => {
      if (enabled("debug")) console.debug("[debug]", ...args);
    },
    info: (...args) => {
      if (enabled("info")) console.info("[info]", ...args);
    },
    warn: (...args) => {
      if (enabled("warn")) console.warn("[warn]", ...args);
    },
    error: (...args) => {
      if (enabled("error")) console.error("[error]", ...args);
    }
  };
}
