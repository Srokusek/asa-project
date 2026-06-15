// big-map.json stores its tile matrix as tiles[x][y].
const DEFAULT_RUNTIME_AGENT_IDS = Object.freeze({
  a1: "5759fb",
  a2: "0e69d4",
  a3: "f9c51b",
  a4: "67d6f4",
  a5: "5b8078",
  a6: "7eedde",
  a7: "bc3b79",
  a8: "c01bdd",
  a9: "0e01e5",
});

const AGENT_SECTORS = Object.freeze({
  a1: "l1",
  a2: "l2",
  a3: "l3",
  a4: "l4",
  a5: "l5",
  a6: "l6",
  a7: "l7",
  a8: "l8",
  a9: "l9"
});

function tile(x, y) {
  return Object.freeze({ x, y });
}

function tileList(coordinates) {
  return Object.freeze(coordinates.map(([x, y]) => tile(x, y)));
}

function configuredAgents(env = process.env) {
  const agents = {};

  for (const [agentId, sectorId] of Object.entries(AGENT_SECTORS)) {
    const envName = `PDDL_${agentId.toUpperCase()}_RUNTIME_AGENT_ID`;
    const runtimeAgentId = String(
      env[envName] ?? DEFAULT_RUNTIME_AGENT_IDS[agentId] ?? ""
    ).trim();

    if (!runtimeAgentId) continue;
    agents[agentId] = Object.freeze({ runtimeAgentId, sectorId });
  }

  return Object.freeze(agents);
}

export const PDDL_MAP_REGISTRY = Object.freeze({
  agents: configuredAgents(),
  pois: Object.freeze({
    s1: Object.freeze({
      kind: "spawner",
      sectors: Object.freeze(["l1"]),
      tiles: tileList([
        [10, 8],
        [10, 9],
        [11, 8],
        [11, 9]
      ])
    }),
    s2: Object.freeze({
      kind: "spawner",
      sectors: Object.freeze(["l2"]),
      tiles: tileList([
        [0, 15],
        [0, 16]
      ])
    }),
    s3: Object.freeze({
      kind: "spawner",
      sectors: Object.freeze(["l3"]),
      tiles: tileList([
        [3, 33],
        [4, 33]
      ])
    }),
    s7: Object.freeze({
      kind: "spawner",
      sectors: Object.freeze(["l7"]),
      tiles: tileList([
        [31, 0],
        [32, 0],
        [33, 0]
      ])
    }),

    d3: Object.freeze({
      kind: "delivery",
      sectors: Object.freeze(["l3"]),
      tiles: tileList([
        [0, 28],
        [0, 29]
      ])
    }),
    d4: Object.freeze({
      kind: "delivery",
      sectors: Object.freeze(["l4"]),
      tiles: tileList([
        [17, 0],
        [18, 0]
      ])
    }),
    d8: Object.freeze({
      kind: "delivery",
      sectors: Object.freeze(["l8"]),
      tiles: tileList([
        [36, 15],
        [36, 16]
      ])
    }),
    d9: Object.freeze({
      kind: "delivery",
      sectors: Object.freeze(["l9"]),
      tiles: tileList([[33, 33], [36, 29]])
    }),

    t12: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l1", "l2"]),
      tiles: tileList([[4, 9]]),
      tilesBySector: Object.freeze({
        l1: Object.freeze({
          pickup: tileList([[4, 7], [4, 8], [4, 9]]),
          dropoff: tileList([[4, 9]])
        }),
        l2: Object.freeze({
          pickup: tileList([[4, 9], [4, 10], [4, 11]]),
          dropoff: tileList([[4, 9]])
        })
      }),
      idleTiles: Object.freeze({
        l1: tile(4, 7),
        l2: tile(4, 11)
      })
    }),
    t14: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l1", "l4"]),
      tiles: tileList([[11, 3]]),
      tilesBySector: Object.freeze({
        l1: Object.freeze({
          pickup: tileList([[9, 3], [10, 3], [11, 3]]),
          dropoff: tileList([[11, 3]])
        }),
        l4: Object.freeze({
          pickup: tileList([[11, 3], [12, 3], [13, 3]]),
          dropoff: tileList([[11, 3]])
        })
      }),
      idleTiles: Object.freeze({
        l1: tile(9, 3),
        l4: tile(13, 3)
      })
    }),
    t23: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l2", "l3"]),
      tiles: tileList([[4, 22]]),
      tilesBySector: Object.freeze({
        l2: Object.freeze({
          pickup: tileList([[4, 20], [4, 21], [4, 22]]),
          dropoff: tileList([[4, 22]])
        }),
        l3: Object.freeze({
          pickup: tileList([[4, 22], [4, 23], [4, 24]]),
          dropoff: tileList([[4, 22]])
        })
      }),
      idleTiles: Object.freeze({
        l2: tile(4, 20),
        l3: tile(4, 24)
      })
    }),
    t25a: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l2", "l5"]),
      tiles: tileList([[11, 13]]),
      tilesBySector: Object.freeze({
        l2: Object.freeze({
          pickup: tileList([[9, 13], [10, 13], [11, 13]]),
          dropoff: tileList([[11, 13]])
        }),
        l5: Object.freeze({
          pickup: tileList([[11, 13], [12, 13], [13, 13]]),
          dropoff: tileList([[11, 13]])
        })
      }),
      idleTiles: Object.freeze({
        l2: tile(9, 13),
        l5: tile(13, 13)
      })
    }),
    t25b: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l2", "l5"]),
      tiles: tileList([[11, 18]]),
      tilesBySector: Object.freeze({
        l2: Object.freeze({
          pickup: tileList([[9, 18], [10, 18], [11, 18]]),
          dropoff: tileList([[11, 18]])
        }),
        l5: Object.freeze({
          pickup: tileList([[11, 18], [12, 18], [13, 18]]),
          dropoff: tileList([[11, 18]])
        })
      }),
      idleTiles: Object.freeze({
        l2: tile(9, 18),
        l5: tile(13, 18)
      })
    }),
    t36: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l3", "l6"]),
      tiles: tileList([[11, 28]]),
      tilesBySector: Object.freeze({
        l3: Object.freeze({
          pickup: tileList([[9, 28], [10, 28], [11, 28]]),
          dropoff: tileList([[11, 28]])
        }),
        l6: Object.freeze({
          pickup: tileList([[11, 28], [12, 28], [13, 28]]),
          dropoff: tileList([[11, 28]])
        })
      }),
      idleTiles: Object.freeze({
        l3: tile(9, 28),
        l6: tile(13, 28)
      })
    }),
    t39: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l3", "l9"]),
      tiles: tileList([[18, 35]]),
      tilesBySector: Object.freeze({
        l3: Object.freeze({
          pickup: tileList([[16, 35], [17, 35], [18, 35]]),
          dropoff: tileList([[18, 35]])
        }),
        l9: Object.freeze({
          pickup: tileList([[18, 35], [19, 35], [20, 35]]),
          dropoff: tileList([[18, 35]])
        })
      }),
      idleTiles: Object.freeze({
        l3: tile(16, 35),
        l9: tile(20, 35)
      })
    }),
    t45: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l4", "l5"]),
      tiles: tileList([[18, 9]]),
      tilesBySector: Object.freeze({
        l4: Object.freeze({
          pickup: tileList([[18, 7], [18, 8], [18, 9]]),
          dropoff: tileList([[18, 9]])
        }),
        l5: Object.freeze({
          pickup: tileList([[18, 9], [18, 10], [18, 11]]),
          dropoff: tileList([[18, 9]])
        })
      }),
      idleTiles: Object.freeze({
        l4: tile(18, 7),
        l5: tile(18, 11)
      })
    }),
    t47: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l4", "l7"]),
      tiles: tileList([[24, 2]]),
      tilesBySector: Object.freeze({
        l4: Object.freeze({
          pickup: tileList([[22, 2], [23, 2], [24, 2]]),
          dropoff: tileList([[24, 2]])
        }),
        l7: Object.freeze({
          pickup: tileList([[24, 2], [25, 2], [26, 2]]),
          dropoff: tileList([[24, 2]])
        })
      }),
      idleTiles: Object.freeze({
        l4: tile(22, 2),
        l7: tile(26, 2)
      })
    }),
    t56: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l5", "l6"]),
      tiles: tileList([[18, 22]]),
      tilesBySector: Object.freeze({
        l5: Object.freeze({
          pickup: tileList([[18, 20], [18, 21], [18, 22]]),
          dropoff: tileList([[18, 22]])
        }),
        l6: Object.freeze({
          pickup: tileList([[18, 22], [18, 23], [18, 24]]),
          dropoff: tileList([[18, 22]])
        })
      }),
      idleTiles: Object.freeze({
        l5: tile(18, 20),
        l6: tile(18, 24)
      })
    }),
    t57: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l5", "l7"]),
      tiles: tileList([[25, 9]]),
      tilesBySector: Object.freeze({
        l5: Object.freeze({
          pickup: tileList([[25, 9], [25, 10], [25, 11]]),
          dropoff: tileList([[25, 9]])
        }),
        l7: Object.freeze({
          pickup: tileList([[25, 7], [25, 8], [25, 9]]),
          dropoff: tileList([[25, 9]])
        })
      }),
      idleTiles: Object.freeze({
        l5: tile(25, 11),
        l7: tile(25, 7)
      })
    }),
    t69a: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l6", "l9"]),
      tiles: tileList([[25, 26]]),
      tilesBySector: Object.freeze({
        l6: Object.freeze({
          pickup: tileList([[23, 26], [24, 26], [25, 26]]),
          dropoff: tileList([[25, 26]])
        }),
        l9: Object.freeze({
          pickup: tileList([[25, 26], [26, 26], [27, 26]]),
          dropoff: tileList([[25, 26]])
        })
      }),
      idleTiles: Object.freeze({
        l6: tile(23, 26),
        l9: tile(27, 26)
      })
    }),
    t69b: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l6", "l9"]),
      tiles: tileList([[25, 31]]),
      tilesBySector: Object.freeze({
        l6: Object.freeze({
          pickup: tileList([[23, 31], [24, 31], [25, 31]]),
          dropoff: tileList([[25, 31]])
        }),
        l9: Object.freeze({
          pickup: tileList([[25, 31], [26, 31], [27, 31]]),
          dropoff: tileList([[25, 31]])
        })
      }),
      idleTiles: Object.freeze({
        l6: tile(23, 31),
        l9: tile(27, 31)
      })
    }),
    t78: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l7", "l8"]),
      tiles: tileList([[32, 9]]),
      tilesBySector: Object.freeze({
        l7: Object.freeze({
          pickup: tileList([[32, 7], [32, 8], [32, 9]]),
          dropoff: tileList([[32, 9]])
        }),
        l8: Object.freeze({
          pickup: tileList([[32, 9], [32, 10], [32, 11]]),
          dropoff: tileList([[32, 9]])
        })
      }),
      idleTiles: Object.freeze({
        l7: tile(32, 7),
        l8: tile(32, 11)
      })
    }),
    t89: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l8", "l9"]),
      tiles: tileList([[32, 22]]),
      tilesBySector: Object.freeze({
        l8: Object.freeze({
          pickup: tileList([[32, 20], [32, 21], [32, 22]]),
          dropoff: tileList([[32, 22]])
        }),
        l9: Object.freeze({
          pickup: tileList([[32, 22], [32, 23], [32, 24]]),
          dropoff: tileList([[32, 22]])
        })
      }),
      idleTiles: Object.freeze({
        l8: tile(32, 20),
        l9: tile(32, 24)
      })
    })
  })
});
