# Deliveroo Planner Agent

Node.js ESM agent for Deliveroo.js cloud using the official `@unitn-asa/deliveroo-js-sdk`.

## Install

```bash
npm install
```

## Configuration

Create `.env` from `.env.example`:

```env
HOST=deliveroojs.azurewebsites.net
TOKEN=INSERISCI_TOKEN
AGENT_NAME=PlannerAgent
LOG_LEVEL=info
ACTION_DELAY_MS=100
```

Alternative hosts:

```env
HOST=deliveroojsdev.azurewebsites.net
HOST=deliveroojs.bears.disi.unitn.it
```

## Run

```bash
npm start
```

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
