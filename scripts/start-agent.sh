#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <agent-name> <env-file>" >&2
  exit 2
fi

agent_name="$1"
env_file="$2"
log_file="logs/agents/${agent_name}.log"

mkdir -p logs/agents
truncate -s 0 "$log_file"

echo "Starting ${agent_name} with ${env_file}"
echo "Logs: ${log_file}"

exec env DOTENV_CONFIG_PATH="$env_file" node src/index.js >"$log_file" 2>&1
