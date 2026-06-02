# Agent Context

This document is for coding agents and maintainers. It describes where behavior belongs in the final architecture and where it should not be added.

## System Shape

The repo has two runtime agents:

- `StandardBDIAgent`: normal BDI player.
- `CoordinationBDIAgent`: normal BDI player plus asynchronous LLM sidecar.

Both agents use the same BDI gameplay stack. The LLM sidecar never controls low-level actions. It can propose only structured macro artifacts:

- `MissionSpec`
- `CoordinationPlan`
- `TeamProtocol` messages

Those artifacts are validated before they affect beliefs, missions, coordination state, or execution.

## BDI Loop

The operative loop is in `src/control/agent-loop.js`.

Runtime flow:

1. `sdk-adapter` receives SDK events.
2. `BeliefState` updates partial world memory.
3. TeamProtocol messages are routed to `MessageRouter` and `CoordinationController`.
4. The loop builds `PlannerState` from beliefs.
5. The planner/search/pathfinding stack chooses a route-level plan.
6. `executable-plan` turns the route into `move`, `pick_up`, and `put_down`.
7. `ReactiveLayer` may take immediate guarded actions.
8. `Executor` calls the SDK and reports success, busy, or failure.
9. The loop replans when events, stale plans, traffic, failed actions, missions, or constraints require it.

Important rule: the loop stays BDI. Do not add an LLM branch that emits direct movement actions.

## Mission Registry

`src/missions/mission-registry.js` is the stateful owner of active missions.

Use it for:

- adding validated `MissionSpec` objects,
- marking missions accepted, rejected, completed, failed, expired, or cancelled,
- querying active level 1/2/3 missions,
- exposing active delivery rules through `activeDeliveryRules`.

Do not duplicate active mission lists in agents, planner files, or the LLM sidecar. Agents may keep small sent-plan maps for bookkeeping, but mission semantics should live in the registry.

## MissionSpec

`src/missions/mission-spec.js` defines mission types, levels, normalization, and validation.

Current level groups:

- Level 1: direct/simple tasks such as `GOTO_TILE`, `PICKUP_AT_TILE`, `DELIVER_AT_TILE`.
- Level 2: constraints and reward modifiers such as `FORBIDDEN_TILE`, `STACK_EXACTLY_N`, tile/count multipliers, parcel filters.
- Level 3: coordination macro types such as `RENDEZVOUS`, `BOTH_NEAR_POSITION`, `COORDINATED_WAIT`, `RED_LIGHT_GREEN_LIGHT`, `HANDOFF`.

Level 3 specs must set `requiresCoordination: true`.

## Delivery Rules And Reward Model

`src/missions/delivery-rules.js` converts active missions into planner-facing rules.

`src/missions/reward-model.js` is the single source for delivery legality and value:

- hard stack mismatch forbids delivery,
- soft stack mismatch allows delivery without the exact-stack bonus,
- satisfied stack count can apply a multiplier,
- legacy delivery count multipliers still compose,
- incompatible hard exact-stack rules resolve by highest priority, then latest rule.

Do not reimplement delivery legality inside planner/search. Call `evaluateDelivery`.

## Delivery Policy

`src/strategy/delivery-policy.js` separates:

- `deliveryForbidden`: hard rule says delivery is not legal,
- `deliveryDeferred`: delivery is legal but not preferred yet.

Planner/search must block only forbidden delivery. Deferred delivery can be penalized but must remain available as a fallback when no valid pickup/harvest path exists.

## Reactive Layer

`src/strategy/reactive-layer.js` is for guarded immediate actions only.

It validates before acting:

- `pick_up`: parcel is still visible, on the same tile, not carried, and allowed by mission filters.
- `put_down`: agent is on a red tile, carries parcels, and `evaluateDelivery` allows delivery.
- `move`: path rules, forbidden tiles, temporary blocks, and occupied next cells.

If the current plan action is stale or invalid, invalidate the plan and let normal planning/traffic policy decide. Do not add random fallback moves here.

## Coordination Controller

`src/coordination/coordination-controller.js` owns Level 3 execution state.

It handles:

- `POSITION_HEARTBEAT`: updates lightweight TeamState.
- `COORDINATION_PLAN`: accepts plans assigned to local aliases.
- `SUBGOAL_ASSIGNMENT`: creates local subgoals or constraints.
- `RENDEZVOUS` and `BOTH_NEAR_POSITION`: goto target plus ready/status messages.
- `COORDINATED_WAIT`: wait state and ready/status after the configured tick.
- `RED_LIGHT_GREEN_LIGHT`: movement blocking/resume constraint.
- `HANDOFF`: explicit unsupported failure.

State machine:

- `RECEIVED`
- `ACCEPTED`
- `EXECUTING`
- `WAITING_TEAMMATE`
- `READY`
- `COMPLETED`
- `FAILED`
- `ABORTED`

Plans must have a ttl. Expired plans and stale teammates fail explicitly.

## TeamProtocol And Router

`src/communication/team-protocol.js` validates structured messages.

Critical validated types include:

- `MISSION_SPEC`
- `COORDINATION_PLAN`
- `SUBGOAL_ASSIGNMENT`
- `POSITION_HEARTBEAT`
- `STATUS_UPDATE`
- `RENDEZVOUS_READY`
- `MISSION_COMPLETED`
- `MISSION_FAILED`

`src/communication/message-router.js` owns alias matching, deduplication, expiry filtering, and team inboxes. Use `buildAgentAliases` and `consumeTeamMessagesForAliases`; do not add manual alias loops in agent classes.

TeamProtocol messages must remain compact. Do not send full maps, full beliefs, or full history.

## LLM Sidecar Boundaries

LLM-related code belongs in:

- `src/agents/llm-coordination-agent.js`: sidecar lifecycle and publication of validated structured output.
- `src/llm/mission-prompt.js`: compact prompt/context construction.
- `src/missions/mission-parser.js`: JSON parsing, validation, retry handling, alias normalization.
- `src/llm/llm-client.js` / `src/chat/llm-client.js`: client wrapper.

Do not put LLM logic in:

- planner/pathfinding,
- `AgentLoop` decision branches,
- `Executor`,
- `ReactiveLayer`,
- `RewardModel`,
- `sdk-adapter` beyond keeping protocol messages out of natural chat.

The LLM context should stay compact:

- own id/name/role,
- teammate summary,
- own and teammate positions,
- carried counts,
- active mission summary,
- red/green summary,
- active constraints,
- supported mission/team message types.

## Where Not To Add New Modes

Avoid adding new planner or loop modes for each mission phrase.

Prefer these extension points:

- New delivery constraint: `MissionSpec` -> `DeliveryRules` -> `RewardModel`.
- New team macro: `MissionSpec`/`CoordinationPlan` -> `CoordinationController`.
- New immediate safety check: `ReactiveLayer`.
- New message type: `TeamProtocol` validation -> `MessageRouter`/agent handler.
- New LLM output shape: `mission-prompt` and `mission-parser`, then existing BDI path.

Do not create a separate low-level LLM executor, custom WebSocket protocol, or parallel planner.

## Compatibility Surfaces

Kept for compatibility/debug:

- `src/llm-chat-agent.js`: legacy `chat:llm` entrypoint, delegates to `CoordinationBDIAgent`.
- `src/control/chat-processor.js`: optional natural-language/manual-tool processor, disabled in both normal two-agent runtimes.
- `src/missions/mission-tools.js`: helper tools used by `chat-processor`.
- Direct belief overlays for forbidden tiles and multipliers: retained for manual/debug compatibility, merged into planner-state.

Current mission-driven behavior should prefer `MissionRegistry`, `DeliveryRules`, and `RewardModel`.

## Real TODOs

- Physical `HANDOFF` needs an environment-supported transfer primitive before it can become more than explicit unsupported/fallback.
- PDDL is not wired. `requiresPddl` is metadata only unless a real adapter and tests are added.
- `PICKUP_AT_TILE` and `DELIVER_AT_TILE` are representable MissionSpec types; direct bespoke handlers should be added only if normal planner/executor behavior is insufficient.
- Runtime validation still needs live Deliveroo matches with two real tokens, not just unit tests.

## Verification

Required local checks:

```bash
npm test
```

```powershell
$files = @(Get-ChildItem -Recurse -File src,test -Filter *.js | ForEach-Object { $_.FullName })
foreach ($file in $files) { node --check $file; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

Startup smoke:

```bash
npm run start:bdi
npm run start:llm
```

The startup scripts connect to the configured Deliveroo host. Without a server/valid token, connection errors after import/startup are expected.
