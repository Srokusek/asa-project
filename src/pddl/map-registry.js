// test-map.json stores its tile matrix as tiles[x][y].
const RUNTIME_AGENT_IDS = Object.freeze({
  a1: "5759fb",
  a2: "0e69d4",
  a3: "0e01e5"
});

export const PDDL_MAP_REGISTRY = Object.freeze({
  agents: Object.freeze({
    a1: Object.freeze({
      runtimeAgentId: RUNTIME_AGENT_IDS.a1,
      sectorId: "l1"
    }),
    a2: Object.freeze({
      runtimeAgentId: RUNTIME_AGENT_IDS.a2,
      sectorId: "l2"
    }),
    a3: Object.freeze({
      runtimeAgentId: RUNTIME_AGENT_IDS.a3,
      sectorId: "l3"
    })
  }),
  pois: Object.freeze({
    s1: Object.freeze({
      kind: "spawner",
      sectors: Object.freeze(["l1"]),
      tiles: Object.freeze([
        Object.freeze({ x: 1, y: 1 }),
        Object.freeze({ x: 1, y: 2 }),
        Object.freeze({ x: 2, y: 1 }),
        Object.freeze({ x: 2, y: 2 })
      ])
    }),
    s2: Object.freeze({
      kind: "spawner",
      sectors: Object.freeze(["l2"]),
      tiles: Object.freeze([
        Object.freeze({ x: 1, y: 24 }),
        Object.freeze({ x: 1, y: 25 }),
        Object.freeze({ x: 2, y: 24 }),
        Object.freeze({ x: 2, y: 25 })
      ])
    }),
    d3: Object.freeze({
      kind: "delivery",
      sectors: Object.freeze(["l3"]),
      tiles: Object.freeze([
        Object.freeze({ x: 18, y: 9 }),
        Object.freeze({ x: 18, y: 10 })
      ])
    }),
    t12: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l1", "l2"]),
      tiles: Object.freeze([Object.freeze({ x: 4, y: 13 })]),
      tilesBySector: Object.freeze({
        l1: Object.freeze({
          pickup: Object.freeze([
            Object.freeze({ x: 4, y: 11 }),
            Object.freeze({ x: 4, y: 12 }),
            Object.freeze({ x: 4, y: 13 })
          ]),
          dropoff: Object.freeze([Object.freeze({ x: 4, y: 13 })])
        }),
        l2: Object.freeze({
          pickup: Object.freeze([
            Object.freeze({ x: 4, y: 13 }),
            Object.freeze({ x: 4, y: 14 }),
            Object.freeze({ x: 4, y: 15 })
          ]),
          dropoff: Object.freeze([Object.freeze({ x: 4, y: 13 })])
        })
      }),
      idleTiles: Object.freeze({
        l1: Object.freeze({ x: 4, y: 11 }),
        l2: Object.freeze({ x: 4, y: 15 })
      })
    }),
    t13: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l1", "l3"]),
      tiles: Object.freeze([Object.freeze({ x: 15, y: 4 })]),
      tilesBySector: Object.freeze({
        l1: Object.freeze({
          pickup: Object.freeze([
            Object.freeze({ x: 13, y: 4 }),
            Object.freeze({ x: 14, y: 4 }),
            Object.freeze({ x: 15, y: 4 })
          ]),
          dropoff: Object.freeze([Object.freeze({ x: 15, y: 4 })])
        }),
        l3: Object.freeze({
          pickup: Object.freeze([
            Object.freeze({ x: 15, y: 4 }),
            Object.freeze({ x: 16, y: 4 }),
            Object.freeze({ x: 17, y: 4 })
          ]),
          dropoff: Object.freeze([Object.freeze({ x: 15, y: 4 })])
        })
      }),
      idleTiles: Object.freeze({
        l1: Object.freeze({ x: 13, y: 4 }),
        l3: Object.freeze({ x: 17, y: 4 })
      })
    }),
    t23: Object.freeze({
      kind: "transfer",
      sectors: Object.freeze(["l2", "l3"]),
      tiles: Object.freeze([Object.freeze({ x: 15, y: 18 })]),
      tilesBySector: Object.freeze({
        l2: Object.freeze({
          pickup: Object.freeze([
            Object.freeze({ x: 13, y: 18 }),
            Object.freeze({ x: 14, y: 18 }),
            Object.freeze({ x: 15, y: 18 })
          ]),
          dropoff: Object.freeze([Object.freeze({ x: 15, y: 18 })])
        }),
        l3: Object.freeze({
          pickup: Object.freeze([
            Object.freeze({ x: 15, y: 18 }),
            Object.freeze({ x: 16, y: 18 }),
            Object.freeze({ x: 17, y: 18 })
          ]),
          dropoff: Object.freeze([Object.freeze({ x: 15, y: 18 })])
        })
      }),
      idleTiles: Object.freeze({
        l2: Object.freeze({ x: 13, y: 18 }),
        l3: Object.freeze({ x: 17, y: 18 })
      })
    })
  })
});
