# Deliveroo BDI Team Agent

Node.js ESM agents for Deliveroo.js using the official `@unitn-asa/deliveroo-js-sdk`.

The repository contains two separate runtime agents:

- `StandardBDIAgent`: a normal BDI player.
- `CoordinationBDIAgent`: a BDI player with an asynchronous LLM sidecar.

Both agents play through the same BDI loop, planner, pathfinding, action guards, and executor. The LLM sidecar does not control low-level moves. It can only produce structured macro artifacts: `MissionSpec`, `CoordinationPlan`, and `TeamProtocol` messages.

## Install

```bash
npm install
```

## Environment

Create a `.env` file with one Deliveroo token/name per process:

```env
HOST=deliveroojs.azurewebsites.net

BDI_TOKEN=standard_agent_deliveroo_token
BDI_AGENT_NAME=StandardBDIAgent

LLM_TOKEN=coordination_agent_deliveroo_token
LLM_AGENT_NAME=CoordinationBDIAgent

AGENT_ROLE=bdi
LOG_LEVEL=info
ACTION_DELAY_MS=100
```

`AGENT_ROLE=bdi` starts `StandardBDIAgent`. `AGENT_ROLE=llm` starts `CoordinationBDIAgent`.

Fallback behavior:

- If `BDI_TOKEN` is missing, role `bdi` falls back to `TOKEN`.
- If `LLM_TOKEN` is missing, role `llm` falls back to `TOKEN`.
- If both roles resolve to the same token, startup prints a warning.

Optional LLM sidecar settings, used only by `CoordinationBDIAgent`:

```env
LITELLM_API_KEY=llm_provider_key
LITELLM_BASE_URL=https://llm.bears.disi.unitn.it/v1
LOCAL_MODEL=llama-3.3-70b-lmstudio
```

These are the current variable names read by the code. If a deployment calls them `LLM_API_KEY`, `BASE_URL`, or `MODEL`, map those names to `LITELLM_API_KEY`, `LITELLM_BASE_URL`, and `LOCAL_MODEL` before launching.

Team heartbeat settings:

```env
TEAM_HEARTBEAT_TICKS=5
TEAM_HEARTBEAT_TTL_TICKS=15
```

For fast competition runs, set `ACTION_DELAY_MS=0` to use the self-scheduled fastest safe loop.

## Run

Start the two roles as two separate processes:

```bash
npm run start:bdi
npm run start:llm
```

Compatibility entrypoint:

```bash
npm run chat:llm
```

`chat:llm` delegates to `CoordinationBDIAgent`; it is kept for compatibility and is not the preferred two-process startup path.

## Architecture

Runtime graph:

```text
Deliveroo SDK events
  -> sdk-adapter
  -> BeliefState + TeamState
  -> PlannerState
  -> route planner / search / pathfinding
  -> executable-plan
  -> Executor
  -> SDK actions
```

Structured team communication graph:

```text
SDK message
  -> sdk-adapter
  -> MessageRouter
  -> CoordinationController
  -> local subgoal, status, or constraint
```

LLM sidecar graph:

```text
natural chat request
  -> compact LLM context
  -> mission prompt
  -> mission-parser
  -> MissionSpec / CoordinationPlan / TeamProtocol
  -> BDI validation and execution path
```

Important boundaries:

- `StandardBDIAgent` receives no active LLM client/config.
- `CoordinationBDIAgent` has an LLM client, but still moves via BDI.
- Team messages use `TeamProtocol` and are not routed to natural-language LLM parsing.
- Planner/pathfinding is the existing implementation; coordination should not rewrite it.
- `MissionRegistry`, `DeliveryRules`, and `RewardModel` own mission delivery constraints.
- `ReactiveLayer` can take immediate actions only after validating current state.

Main files:

- `src/index.js`: role selection and startup.
- `src/config.js`: env parsing and `buildRoleConfig`.
- `src/agents/standard-bdi-agent.js`: standard BDI runtime.
- `src/agents/llm-coordination-agent.js`: BDI runtime plus LLM sidecar.
- `src/control/agent-loop.js`: BDI tick and replanning.
- `src/state/belief-state.js`: world model, team state, mission registry.
- `src/state/sdk-adapter.js`: SDK event/message boundary.
- `src/communication/team-protocol.js`: structured message validation.
- `src/communication/message-router.js`: aliases, expiry, deduplication, inboxes.
- `src/coordination/coordination-controller.js`: Level 3 coordination state machine.
- `src/missions/mission-spec.js`: mission types and validation.
- `src/missions/delivery-rules.js`: mission-to-delivery-rule conversion.
- `src/missions/reward-model.js`: delivery legality and value.
- `src/strategy/reactive-layer.js`: guarded immediate actions.

## Level Support

Level 1 examples:

- `GOTO_TILE`: queues a local BDI/manual goto task.
- `PICKUP_AT_TILE`, `DELIVER_AT_TILE`, `DROP_ON_TILE`: representable mission types; concrete pickup/delivery still goes through planner/executor guards.
- `ANSWER_CHAT`, `CALCULATE_EXPRESSION`: compatibility chat-tool concepts, not part of normal two-agent coordination.

Level 2 examples:

- `FORBIDDEN_TILE`: planner/pathfinding avoids the tile.
- `PICKUP_TILE_MULTIPLIER`: changes pickup scoring for a tile.
- `DELIVERY_TILE_MULTIPLIER`: changes delivery value for a red tile.
- `DELIVERY_COUNT_MULTIPLIER`: legacy exact-count reward multiplier.
- `STACK_EXACTLY_N`: applies count constraint and optional reward multiplier.
- `PARCEL_VALUE_FILTER`: blocks or penalizes parcels outside value bounds.

`STACK_EXACTLY_N` behavior:

- hard mismatch: delivery is forbidden.
- soft mismatch: delivery is allowed, but no exact-stack bonus is applied.
- multiplier match: reward multiplier applies when carried count equals the requested count.
- hard conflicts: highest priority wins; ties resolve by latest rule.

Level 3 examples currently supported by `CoordinationController`:

- `RENDEZVOUS`: local goto target plus ready/status messages.
- `BOTH_NEAR_POSITION`: same execution path as rendezvous.
- `COORDINATED_WAIT`: wait state until tick/condition and then ready/status.
- `RED_LIGHT_GREEN_LIGHT`: movement constraint; message/status actions remain allowed.
- `HANDOFF`: explicit unsupported/fallback failure with reason.

## TeamProtocol Examples

TeamProtocol messages are JSON objects with this envelope:

```json
{
  "protocol": "ASA_TEAM_V1",
  "id": "team_heartbeat_42",
  "type": "POSITION_HEARTBEAT",
  "from": "StandardBDIAgent",
  "to": null,
  "tick": 42,
  "ttl": 15,
  "payload": {
    "agentId": "agent-1",
    "agentName": "StandardBDIAgent",
    "role": "bdi",
    "position": { "x": 5, "y": 7 },
    "score": 12,
    "carriedCount": 2,
    "currentTask": "PICKUP_DELIVERY_UNIFIED",
    "ready": false,
    "tick": 42
  }
}
```

MissionSpec message:

```json
{
  "protocol": "ASA_TEAM_V1",
  "id": "team_mission_stack3",
  "type": "MISSION_SPEC",
  "from": "CoordinationBDIAgent",
  "to": "standard-bdi-agent",
  "tick": 50,
  "ttl": 80,
  "payload": {
    "missionSpec": {
      "id": "mission_stack_3_double",
      "type": "STACK_EXACTLY_N",
      "level": 2,
      "status": "ACTIVE",
      "objective": { "count": 3, "multiplier": 2 },
      "constraints": [
        { "kind": "STACK_EXACTLY_N", "count": 3, "hard": true, "multiplier": 2 }
      ],
      "rewardModifiers": [
        { "kind": "STACK_COUNT_MULTIPLIER", "count": 3, "multiplier": 2 }
      ],
      "requiresCoordination": false,
      "reason": "deliver exactly 3 parcels for double reward"
    }
  }
}
```

CoordinationPlan message:

```json
{
  "protocol": "ASA_TEAM_V1",
  "id": "team_coord_rendezvous",
  "type": "COORDINATION_PLAN",
  "from": "CoordinationBDIAgent",
  "to": null,
  "tick": 80,
  "ttl": 80,
  "payload": {
    "coordinationPlan": {
      "id": "coord_rendezvous_1",
      "missionId": "mission_rendezvous_1",
      "type": "RENDEZVOUS",
      "ttl": 80,
      "roles": {
        "standard-bdi-agent": {
          "type": "RENDEZVOUS",
          "target": { "x": 6, "y": 4 },
          "maxDistance": 1
        },
        "coordination-agent": {
          "type": "RENDEZVOUS",
          "target": { "x": 6, "y": 4 },
          "maxDistance": 1
        }
      },
      "phases": [
        { "id": "meet", "type": "RENDEZVOUS" },
        { "id": "wait", "type": "COORDINATED_WAIT", "waitTicks": 3 }
      ],
      "successConditions": ["both_agents_ready"],
      "failureConditions": ["ttl_expired", "teammate_stale"],
      "fallbackPolicy": "continue_bdi"
    }
  }
}
```

## MissionSpec Examples

Level 1 goto:

```json
{
  "id": "mission_goto_6_4",
  "type": "GOTO_TILE",
  "level": 1,
  "status": "ACTIVE",
  "objective": { "target": { "x": 6, "y": 4 } },
  "assignedTo": "standard-bdi-agent",
  "reason": "move to staging tile"
}
```

Level 2 exact stack:

```json
{
  "id": "mission_stack_3_double",
  "type": "STACK_EXACTLY_N",
  "level": 2,
  "status": "ACTIVE",
  "objective": { "count": 3, "multiplier": 2 },
  "constraints": [
    { "kind": "STACK_EXACTLY_N", "count": 3, "hard": true, "multiplier": 2 }
  ],
  "rewardModifiers": [
    { "kind": "STACK_COUNT_MULTIPLIER", "count": 3, "multiplier": 2 }
  ],
  "reason": "deliver exactly 3 parcels for double reward"
}
```

Level 3 rendezvous mission with macro plan:

```json
{
  "id": "mission_rendezvous_1",
  "type": "RENDEZVOUS",
  "level": 3,
  "status": "ACTIVE",
  "objective": {
    "target": { "x": 6, "y": 4 },
    "coordinationPlan": {
      "id": "coord_rendezvous_1",
      "missionId": "mission_rendezvous_1",
      "type": "RENDEZVOUS",
      "roles": {
        "standard-bdi-agent": { "type": "RENDEZVOUS", "target": { "x": 6, "y": 4 }, "maxDistance": 1 },
        "coordination-agent": { "type": "RENDEZVOUS", "target": { "x": 6, "y": 4 }, "maxDistance": 1 }
      },
      "phases": [{ "id": "meet", "type": "RENDEZVOUS" }],
      "ttl": 80
    }
  },
  "requiresCoordination": true,
  "reason": "both agents near staging tile"
}
```

## Limits

- Physical parcel handoff is not implemented because the current environment/API path does not expose a safe direct transfer primitive. `HANDOFF` fails explicitly with `handoff_not_supported_by_environment`.
- PDDL is not wired into runtime planning. `requiresPddl` is retained as mission metadata/stub intent only.
- The LLM is macro-planning only. It must not emit `move`, `pick_up`, or `put_down`.
- TeamState is intentionally small: teammate identity, position, last seen tick, carried count, current task, and ready flag.
- TeamProtocol payloads are capped and validated; full map, full belief, and full history sharing are intentionally avoided.
- Full runtime validation still depends on a live Deliveroo server and real credentials.

## Tests

```bash
npm test
```

Syntax check on source and tests:

```powershell
$files = @(Get-ChildItem -Recurse -File src,test -Filter *.js | ForEach-Object { $_.FullName })
foreach ($file in $files) { node --check $file; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

Import/startup smoke:

```bash
npm run start:bdi
npm run start:llm
```

The start scripts attempt to connect to the configured Deliveroo host. Without a running server or valid credentials, connection may fail after import/startup succeeds.

## Planner Notes

- No reinforcement learning.
- No Bellman/MDP full-state planning.
- No full stateful A* over inventory/cell state.
- A*/BFS/Manhattan are used inside the distance oracle between important points.
- Sequence search is beam search over `START -> green -> green -> ... -> red`.
- Green scoring is local and uses log-sum-exp.
- Green cells without a currently believed parcel above confidence threshold are not pickup targets.
