export const explicitPlanTool = {
  type: "function",
  function: {
    name: "set_explicit_plan",
    description: "Create an explicit manual plan for the agent.",
    parameters: {
      type: "object",
      properties: {
        goalType: { type: "string", enum: ["goto_tile"] },
        target: {
          type: "object",
          properties: {
            x: { type: "integer" },
            y: { type: "integer" }
          },
          required: ["x", "y"],
          additionalProperties: false
        },
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              x: { type: "integer" },
              y: { type: "integer" }
            },
            required: ["x", "y"],
            additionalProperties: false
          },
          minItems: 1,
          maxItems: 12
        },
        reason: { type: "string" },
        priority: { type: "string", enum: ["override_once", "sticky_until_done"] },
        expiresTicks: { type: "integer", minimum: 1, maximum: 300 }
      },
      required: ["goalType"],
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
    description: "Mark a tile as sticky-forbidden so the planner treats it as unwalkable.",
    parameters: {
      type: "object",
      properties: {
        goalType: { type: "string", enum: ["forbid_tile"] },
        target: {
          type: "object",
          properties: {
            x: { type: "integer" },
            y: { type: "integer" }
          },
          required: ["x", "y"],
          additionalProperties: false
        },
        reason: { type: "string" }
      },
      required: ["goalType", "target"],
      additionalProperties: false
    }
  }
};

export const setPickupTileMultiplierTool = {
  type: "function",
  function: {
    name: "set_pickup_tile_multiplier",
    description: "Set a sticky reward multiplier for packages picked up from a tile.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: { x: { type: "integer" }, y: { type: "integer" } },
          required: ["x", "y"],
          additionalProperties: false
        },
        multiplier: { type: "number", exclusiveMinimum: 0 },
        reason: { type: "string" }
      },
      required: ["target", "multiplier"],
      additionalProperties: false
    }
  }
};

export const setDeliveryTileMultiplierTool = {
  type: "function",
  function: {
    name: "set_delivery_tile_multiplier",
    description: "Set a sticky reward multiplier for deliveries to a tile.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: { x: { type: "integer" }, y: { type: "integer" } },
          required: ["x", "y"],
          additionalProperties: false
        },
        multiplier: { type: "number", exclusiveMinimum: 0 },
        reason: { type: "string" }
      },
      required: ["target", "multiplier"],
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

export const chatTools = [
  calculateExpressionsTool,
  explicitPlanTool,
  setForbiddenTileTool,
  setPickupTileMultiplierTool,
  setDeliveryTileMultiplierTool,
  setDeliveryCountMultiplierTool
];
