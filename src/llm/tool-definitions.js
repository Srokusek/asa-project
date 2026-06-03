const coordinateTargetSchema = {
  type: "object",
  description: "Exact tile coordinates. Use this only when the admin explicitly gives coordinates such as x=4, y=9 or (4,9). Do not invent coordinates for relative requests like leftmost or rightmost.",
  properties: {
    x: { type: "integer", description: "Tile x coordinate." },
    y: { type: "integer", description: "Tile y coordinate." }
  },
  required: ["x", "y"],
  additionalProperties: false
};

const tileSelectorSchema = {
  type: "object",
  description: "Relative tile selector. Use this instead of target coordinates when the admin says leftmost, rightmost, topmost, or bottommost. The executor resolves it against the current map. Example: { extreme: 'rightmost', scope: 'pickup' }.",
  properties: {
    extreme: {
      type: "string",
      enum: ["leftmost", "rightmost", "topmost", "bottommost"],
      description: "Which extreme tile to choose from the candidate set."
    },
    scope: {
      type: "string",
      enum: ["pickup", "delivery", "walkable"],
      description: "Candidate set to search. Use pickup for pickup tiles, delivery for delivery tiles, and walkable for any walkable tile."
    }
  },
  required: ["extreme"],
  additionalProperties: false
};

export const explicitPlanTool = {
  type: "function",
  function: {
    name: "set_explicit_plan",
    description: "Create an explicit manual goto plan for the agent. Use either target for exact coordinates, targets for a fixed sequence, or selector for relative tiles like leftmost/rightmost/topmost/bottommost. Never provide both target and selector.",
    parameters: {
      type: "object",
      properties: {
        goalType: { type: "string", enum: ["goto_tile"] },
        target: coordinateTargetSchema,
        selector: tileSelectorSchema,
        targets: {
          type: "array",
          description: "Optional sequence of exact coordinates for a multi-step explicit route. Do not use this with target or selector.",
          items: {
            ...coordinateTargetSchema,
            description: "One exact coordinate in the explicit route sequence."
          },
          minItems: 1,
          maxItems: 12
        },
        reason: { type: "string", description: "Short operational reason for the override." },
        priority: { type: "string", enum: ["override_once", "sticky_until_done"] }
      },
      required: ["goalType"],
      additionalProperties: false
    }
  }
};

export const teamRendezvousTool = {
  type: "function",
  function: {
    name: "set_team_rendezvous_task",
    description: "Create a sticky rendezvous task for both agents near a target tile. Use this when the admin asks both agents to move to the neighborhood of a coordinate and wait for each other. The executor chooses nearby walkable hold tiles for each agent.",
    parameters: {
      type: "object",
      properties: {
        target: coordinateTargetSchema,
        maxDistance: {
          type: "integer",
          minimum: 0,
          maximum: 30,
          description: "Maximum Manhattan distance from the target tile for the chosen hold tiles. Omit to use the default radius 3."
        },
        reason: { type: "string", description: "Short operational reason for the rendezvous override." }
      },
      required: ["target"],
      additionalProperties: false
    }
  }
};

export const parcelHandoffTool = {
  type: "function",
  function: {
    name: "set_parcel_handoff_task",
    description: "Create a sticky parcel handoff task shared across the LLM agent and its BDI teammate. If target is omitted, auto-pick the nearest walkable tile to the LLM agent. The handoff uses the walkable tiles in the 3x3 zone centered on that tile. The LLM agent will treat only that zone as checkpoint candidates and the BDI teammate will treat only that zone as drop tiles until /clear.",
    parameters: {
      type: "object",
      properties: {
        target: coordinateTargetSchema,
        reason: { type: "string", description: "Short operational reason for the parcel handoff." }
      },
      additionalProperties: false
    }
  }
};

export const calculateExpressionsTool = {
  type: "function",
  function: {
    name: "calculate_expressions",
    description: "Compute arithmetic expressions and return numeric results for subsequent tool calls.",
    parameters: {
      type: "object",
      properties: {
        expressions: {
          type: "object",
          additionalProperties: { type: "string" }
        }
      },
      required: ["expressions"],
      additionalProperties: false
    }
  }
};

export const setForbiddenTileTool = {
  type: "function",
  function: {
    name: "set_forbidden_tile",
    description: "Mark a tile as sticky-forbidden so the planner treats it as unwalkable. Use either target for exact coordinates or selector for relative walkable tiles like the leftmost or rightmost tile. Never provide both target and selector.",
    parameters: {
      type: "object",
      properties: {
        goalType: { type: "string", enum: ["forbid_tile"] },
        target: coordinateTargetSchema,
        selector: tileSelectorSchema,
        reason: { type: "string", description: "Short operational reason for forbidding the tile." }
      },
      required: ["goalType"],
      additionalProperties: false
    }
  }
};

export const setPickupTileMultiplierTool = {
  type: "function",
  function: {
    name: "set_pickup_tile_multiplier",
    description: "Set a sticky reward multiplier for packages picked up from a tile. Use either target for exact pickup-tile coordinates or selector for relative pickup tiles like leftmost/rightmost/topmost/bottommost. Example selector request: 'pickups from the rightmost tile give 1000x points' -> selector { extreme: 'rightmost', scope: 'pickup' }. Never provide both target and selector.",
    parameters: {
      type: "object",
      properties: {
        target: coordinateTargetSchema,
        selector: tileSelectorSchema,
        multiplier: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Positive numeric multiplier literal, for example 2 or 1000. Do not quote the number as a string."
        },
        reason: { type: "string", description: "Short operational reason for the reward rule." }
      },
      required: ["multiplier"],
      additionalProperties: false
    }
  }
};

export const setDeliveryTileMultiplierTool = {
  type: "function",
  function: {
    name: "set_delivery_tile_multiplier",
    description: "Set a sticky reward multiplier for deliveries to a tile. Use either target for exact delivery-tile coordinates or selector for relative delivery tiles like leftmost/rightmost/topmost/bottommost. Example: selector { extreme: 'leftmost', scope: 'delivery' }. Never provide both target and selector.",
    parameters: {
      type: "object",
      properties: {
        target: coordinateTargetSchema,
        selector: tileSelectorSchema,
        multiplier: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Positive numeric multiplier literal, for example 1.5 or 3. Do not quote the number as a string."
        },
        reason: { type: "string", description: "Short operational reason for the reward rule." }
      },
      required: ["multiplier"],
      additionalProperties: false
    }
  }
};

export const setPickupTileBonusTool = {
  type: "function",
  function: {
    name: "set_pickup_tile_bonus",
    description: "Set a sticky additive reward bonus for packages picked up from a tile. Use either target for exact pickup-tile coordinates or selector for relative pickup tiles like leftmost/rightmost/topmost/bottommost. Example: selector { extreme: 'rightmost', scope: 'pickup' }. Never provide both target and selector.",
    parameters: {
      type: "object",
      properties: {
        target: coordinateTargetSchema,
        selector: tileSelectorSchema,
        bonus: { type: "number", description: "Signed numeric bonus literal. Negative values are allowed." },
        reason: { type: "string", description: "Short operational reason for the reward rule." }
      },
      required: ["bonus"],
      additionalProperties: false
    }
  }
};

export const setDeliveryTileBonusTool = {
  type: "function",
  function: {
    name: "set_delivery_tile_bonus",
    description: "Set a sticky additive reward bonus for deliveries to a tile. Use either target for exact delivery-tile coordinates or selector for relative delivery tiles like leftmost/rightmost/topmost/bottommost. Example: selector { extreme: 'leftmost', scope: 'delivery' }. Never provide both target and selector.",
    parameters: {
      type: "object",
      properties: {
        target: coordinateTargetSchema,
        selector: tileSelectorSchema,
        bonus: { type: "number", description: "Signed numeric bonus literal. Negative values are allowed." },
        reason: { type: "string", description: "Short operational reason for the reward rule." }
      },
      required: ["bonus"],
      additionalProperties: false
    }
  }
};

export const setDeliveryCountMultiplierTool = {
  type: "function",
  function: {
    name: "set_delivery_count_multiplier",
    description: "Set a sticky reward multiplier for deliveries with an exact package count.",
    parameters: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1 },
        multiplier: { type: "number", minimum: 0 },
        reason: { type: "string" }
      },
      required: ["count", "multiplier"],
      additionalProperties: false
    }
  }
};

export const setDeliveryCountBonusTool = {
  type: "function",
  function: {
    name: "set_delivery_count_bonus",
    description: "Set a sticky additive reward bonus for deliveries with an exact package count.",
    parameters: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1 },
        bonus: { type: "number" },
        reason: { type: "string" }
      },
      required: ["count", "bonus"],
      additionalProperties: false
    }
  }
};

export const setDeliveryValueThresholdMultiplierTool = {
  type: "function",
  function: {
    name: "set_delivery_value_threshold_multiplier",
    description: "Set one global delivery reward multiplier rule based on each parcel's predicted delivered value before delivery tile/count overlays. Use comparison 'gt' for value higher than threshold, or 'lt' for value lower than threshold. Example: 'If you deliver parcels with a value higher than 10 you get no reward' -> { comparison: 'gt', threshold: 10, multiplier: 0 }.",
    parameters: {
      type: "object",
      properties: {
        comparison: {
          type: "string",
          enum: ["gt", "lt"],
          description: "Use 'gt' for strictly greater than the threshold, or 'lt' for strictly less than the threshold."
        },
        threshold: {
          type: "number",
          description: "Numeric value threshold literal, for example 10 or 5.5."
        },
        multiplier: {
          type: "number",
          minimum: 0,
          description: "Non-negative numeric multiplier literal. Use 0 for 'no reward'."
        },
        reason: { type: "string", description: "Short operational reason for the reward rule." }
      },
      required: ["comparison", "threshold", "multiplier"],
      additionalProperties: false
    }
  }
};

export const chatTools = [
  calculateExpressionsTool,
  explicitPlanTool,
  teamRendezvousTool,
  parcelHandoffTool,
  setForbiddenTileTool,
  setPickupTileMultiplierTool,
  setPickupTileBonusTool,
  setDeliveryTileMultiplierTool,
  setDeliveryTileBonusTool,
  setDeliveryCountMultiplierTool,
  setDeliveryCountBonusTool,
  setDeliveryValueThresholdMultiplierTool
];
