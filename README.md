# Deliveroo Planner Agent

Node.js ESM agent for Deliveroo.js cloud using the official `@unitn-asa/deliveroo-js-sdk`.

## Install

```bash
npm install
```

## Configuration

Create `.env` from `.env.example`:

```env
AGENT_TYPE=bdi
HOST=deliveroojs.azurewebsites.net
TOKEN=INSERISCI_TOKEN
AGENT_NAME=PlannerAgent
TEAMMATE_ID=paired_agent_id
LOG_LEVEL=info
ACTION_DELAY_MS=100
```

`AGENT_TYPE` is required and must be either `bdi` or `llm`.

For `llm` mode, also configure an admin id and model access:

```env
AGENT_TYPE=llm
ADMIN_ID=your_admin_id
TEAMMATE_ID=your_bdi_teammate_id
LITELLM_API_KEY=your_key
LITELLM_BASE_URL=https://llm.bears.disi.unitn.it/v1
LOCAL_MODEL=llama-3.3-70b-lmstudio
```

If `AGENT_TYPE=llm` and `ADMIN_ID` is missing, the agent still runs the BDI loop but chat is disabled.

For a paired `llm` + `bdi` team, set `TEAMMATE_ID` in each agent's env file to the other agent's Deliveroo id. The `llm` agent uses it to send normalized JSON teammate sync envelopes for durable tool side effects, and the `bdi` agent uses it to accept only sync messages from that source.

For competition runs, set `ACTION_DELAY_MS` around `20`-`30` for a smoother action loop. The loop still enforces a `20ms` minimum.

Alternative hosts:

```env
HOST=deliveroojsdev.azurewebsites.net
HOST=deliveroojs.bears.disi.unitn.it
```

## Run

```bash
npm start
```

To run a paired team from one checkout, keep two env files in the repo root and start each runtime with its matching script:

```bash
npm run start:bdi
npm run start:llm
```

These scripts load `.env.bdi` and `.env.llm` respectively via `DOTENV_CONFIG_PATH`.
They redirect stdout and stderr to `logs/agents/bdi-1.log` and
`logs/agents/coordinator.log`, matching the filenames used by `scripts/start-team.sh`.

## Test

```bash
npm test
```

## Architecture

Flow:

`SDK events -> BeliefState -> PlannerState -> route-planner -> executable-plan -> executor -> replanning`

File layout:

- `src/index.js`: runtime entry point. Loads config, connects to Deliveroo.js, wires beliefs, SDK listeners, telemetry, and the agent loop.
- `src/config.js`: environment parsing and defaults for BDI, LLM, planner, telemetry, and PDDL solver settings.
- `src/control/`: loop orchestration. `agent-loop.js` owns current plan memory, replanning policy, chat dispatch, and handoff coordination.
- `src/state/`: world-state layer.
  - `belief-state.js`: partial sensing memory for map, me, parcels, agents, carried parcels, and internal events.
  - `sdk-adapter.js`: SDK event adapter. It updates beliefs and applies trusted teammate sync messages.
  - `planner-state.js`: pure conversion from beliefs to planner input.
- `src/planner/`: BDI route planning.
  - `route-planner.js`: reduced-graph route planning entry point.
  - `route-plan.js`: shared route-plan result helpers.
  - `executable-plan.js`: converts route paths into `move`, `pick_up`, and `put_down` actions.
  - `default-params.js`: planner parameter defaults from config.
  - `path/`: grid utilities, pathfinding, distance oracle, and red-tile distance cache.
  - `scoring/`: green-cell scoring and reward overlay helpers.
  - `search/`: sequence search over selected pickup and delivery points.
  - `scout/`: exploration planner for scouting useful map positions.
- `src/executor/`: SDK action execution. `executor.js` awaits actions and pushes failure/success events.
- `src/llm/`: admin chat and tool-calling coordinator mode.
  - `chat-processor.js`: chat lifecycle and model/tool loop.
  - `model-client.js`: LiteLLM/OpenAI-compatible model calls.
  - `tool-definitions.js`: callable admin tools exposed to the model.
  - `tool-executor.js`: tool side effects, including PDDL solve requests and teammate sync.
  - `tile-selector.js`: resolves relative tile requests such as leftmost pickup or nearest delivery.
  - `diagnostics.js`: optional JSONL chat diagnostics logging.
- `src/pddl/`: PDDL planner integration.
  - `planner-client.js`: HTTP client for the external PDDL solver, timeout handling, and solve logging.
  - `problem-builder.js`: builds runtime PDDL problems from registered map templates.
  - `plan-parser.js`: parses PDDL solver output into executable movement steps.
  - `map-registry.js`: registered big-map sectors, sources, targets, and runtime ids.
  - `map-registry-legacy.js`: legacy registry data kept for older map/test references.
  - `*_domain.pddl` and `*_problem.pddl`: domain/problem templates.
- `src/telemetry/`: optional JSONL telemetry writer.
- `src/utils/`: shared geometry, logging, and teammate sync helpers.
- `scripts/`: process helpers for running one agent or the paired BDI/LLM team.
- `test/`: Node test suite for config, state adapters, planner helpers, PDDL integration, LLM tools, diagnostics, and team orchestration.
- `logs/`: runtime output directory. Agent logs and chat diagnostics are generated here.
- `big-map.json` and `test-map.json`: local map fixtures used by planner/PDDL tooling and tests.
- `AGENT_CONTEXT.md`: project notes and operating context for agent development.

## Contributors

This project was developed collaboratively by [Simon Rokusek](https://github.com/Srokusek) and [Daniele Ippolito](https://github.com/DanielSan-hub).

Selected contribution areas:
- Simon Rokusek: BDI planner architecture, route planning, state modeling, and Deliveroo.js runtime integration.
- [Daniele Ippolito](https://github.com/DanielSan-hub): LLM coordinator mode, tool-calling layer, PDDL integration, teammate synchronization, diagnostics, and cross-platform agent launch configuration.

See the [contributors graph](https://github.com/Srokusek/asa-project/graphs/contributors) and [commit history](https://github.com/Srokusek/asa-project/commits?author=DanielSan-hub) for the authoritative project history.

## Deliveroo Rules

- Tile `"0"`: wall / non-walkable.
- Tile `"1"`: green / parcel spawning.
- Tile `"2"`: red / delivery.
- Tile `"3"`: white / walkable.
- Directions: `right = x + 1`, `left = x - 1`, `up = y + 1`, `down = y - 1`.
- Pickup and putdown are explicit SDK actions.
- Score is gained only by `emitPutdown()` on a delivery tile.

## Planner Notes

- No reinforcement learning.
- No Bellman/MDP full-state planning.
- No dominant heatmap that spreads green reward over the grid.
- No full stateful A* over inventory/cell state.
- A*/BFS/Manhattan are used only inside the distance oracle between important points:
  `START + topK green candidates + red delivery points`.
- Sequence search is beam search over:
  `START -> green -> green -> ... -> red`.
- Green scoring is local and uses log-sum-exp.
- Green cells without a currently believed package above confidence threshold are not pickup targets.
