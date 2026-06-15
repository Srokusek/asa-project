#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

mkdir -p logs/agents
find logs/agents -maxdepth 1 -type f -name '*.log' -exec truncate -s 0 {} +

pids=()

start_agent() {
  local name="$1"
  local env_file="$2"
  local log_file="logs/agents/${name}.log"

  echo "Starting ${name} with ${env_file}"

  DOTENV_CONFIG_PATH="$env_file" \
    node src/index.js >"$log_file" 2>&1 &

  pids+=("$!")
}

stop_team() {
  echo
  echo "Stopping agent team..."

  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  wait "${pids[@]}" 2>/dev/null || true
}

trap stop_team EXIT INT TERM

start_agent "coordinator" ".env.llm"
start_agent "bdi-1" ".env.bdi"
start_agent "bdi-2" ".env.bdi2"
start_agent "bdi-3" ".env.bdi3"
start_agent "bdi-4" ".env.bdi4"
start_agent "bdi-5" ".env.bdi5"
start_agent "bdi-6" ".env.bdi6"
start_agent "bdi-7" ".env.bdi7"
start_agent "bdi-8" ".env.bdi8"

echo "Agent team running."
echo "Logs: logs/agents/"
echo "Press Ctrl+C to stop all agents."

wait
