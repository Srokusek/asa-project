export function pddlAvailable() {
  return false;
}

export function planMacroMissionWithPddl() {
  return {
    ok: false,
    reason: "pddl_not_available",
    fallback: "llm_coordination_plan"
  };
}

export const PDDL_USAGE_POLICY = Object.freeze({
  allowed: [
    "macro_level3_coordination",
    "rendezvous",
    "handoff",
    "coordinated_wait",
    "red_light_green_light",
    "split_roles"
  ],
  forbidden: [
    "normal_pathfinding",
    "move_by_move",
    "standard_pickup_delivery"
  ]
});
