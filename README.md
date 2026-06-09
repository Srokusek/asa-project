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

## Test

```bash
npm test
```

## Architecture

Flow:

`SDK events -> BeliefState -> PlannerState -> route-planner -> executable-plan -> executor -> replanning`

File layout:

- `src/index.js`: SDK connection and loop lifecycle.
- `src/state/belief-state.js`: partial sensing memory for map, me, parcels, agents, carried parcels, and internal events.
- `src/state/sdk-adapter.js`: SDK event adapter. It updates only beliefs.
- `src/state/planner-state.js`: pure conversion from beliefs to planner input.
- `src/planner/route-planner.js`: pure route planning on a reduced graph.
- `src/planner/executable-plan.js`: converts route sequence/path into `move`, `pick_up`, `put_down`.
- `src/executor/executor.js`: awaits SDK actions and pushes failure/success events.
- `src/control/agent-loop.js`: owns current plan memory and replanning policy.

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
