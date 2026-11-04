#!/usr/bin/env bash
# ProofOps operator commands. Run as root on the VM:  bash /opt/proofops/app/ops/operator.sh <command>
#
#   status                 what is running: commit, tier, services, workers, runs against the daily cap. Changes nothing.
#   key-check              asks Vultr's free health route whether the installed key is accepted. Prints only the HTTP status.
#   restart                restarts the control plane and Caddy, then checks health.
#   clear-workers          removes leftover worker containers. Refuses while a mission is running.
#   set-daily-limit <n>    changes the daily mission cap, which also changes the most the public demo can spend.
#   scripted --confirm     switches the public demo to the scripted planner. The page header then says "no live AI".
#   live [model]           switches the public demo to the live model. Needs an accepted key.
#   rollback <sha>         redeploys an earlier commit, keeping the current planner mode.
#
# Nothing here runs by itself. Live and scripted change only when an operator runs a command, the page header always
# shows which is running, and evidence bundles record their tier. The key is never printed.
set -euo pipefail

APP=/opt/proofops/app
DEFAULT_MODEL=deepseek-v4.1-flash-1017
env_value() { sed -n "s/^$1=//p" /etc/proofops/control.env; }
deployment() { env_value PROOFOPS_DEPLOYMENT; }
hostname_() { sed -n 's/^Environment=PROOFOPS_HOSTNAME=//p' /etc/systemd/system/caddy.service.d/proofops.conf; }
head_sha() { sudo -u proofops git -C "$APP" rev-parse HEAD; }
health() { curl -fsS -m 10 http://127.0.0.1:4317/api/health; }
wait_healthy() {
  for _ in $(seq 1 20); do
    if health >/dev/null 2>&1; then health; echo; return 0; fi
    sleep 1
  done
  echo "NOT HEALTHY after 20 seconds. Read: journalctl -u proofops -n 30 --no-pager" >&2
  return 1
}
runs_last_24h() {
  sudo -u proofops /usr/local/bin/node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync("/var/lib/proofops/data/runs.db", { readOnly: true });
    console.log(d.prepare("select count(*) c from runs where created_at >= ?").get(new Date(Date.now() - 864e5).toISOString()).c);'
}

cmd="${1:-status}"
case "$cmd" in
  status)
    echo "commit:   $(head_sha)"
    echo "planner:  $(env_value PROOFOPS_PLANNER) $(env_value PROOFOPS_MODEL)"
    echo "health:   $(health 2>/dev/null || echo UNREACHABLE)"
    echo "services: proofops=$(systemctl is-active proofops || true) caddy=$(systemctl is-active caddy || true) docker=$(systemctl is-active docker || true)"
    echo "workers:  $(docker ps -aq --filter label=proofops.run | wc -l) containers, $(ls /run/proofops 2>/dev/null | wc -l) socket folders"
    echo "key file: $([ -s /etc/proofops/inference.env ] && stat -c '%U mode %a' /etc/proofops/inference.env || echo absent)"
    limit="$(systemctl show proofops -p Environment --value | tr ' ' '\n' | sed -n 's/^PROOFOPS_MAX_RUNS_PER_DAY=//p')"
    echo "missions: $(runs_last_24h) in the last 24 hours, cap ${limit:-unset}"
    echo "disk:     $(df -h / | tail -1 | tr -s ' ' | cut -d' ' -f3-5)"
    ;;
  key-check)
    # The header goes to curl on stdin, so the key never appears on a command line.
    code="$(sed -n 's/^PROOFOPS_INFERENCE_API_KEY=/header = "Authorization: Bearer /p' /etc/proofops/inference.env | sed 's/$/"/' \
      | curl -s -o /dev/null -m 20 -w '%{http_code}' -K - https://api.vultrinference.com/v1/health)"
    echo "Vultr health route answered HTTP $code"
    [ "$code" = 200 ]
    ;;
  restart)
    systemctl restart proofops
    systemctl restart caddy
    wait_healthy
    ;;
  clear-workers)
    if health 2>/dev/null | grep -q '"active":"run_'; then echo "A mission is running. Cancel it or wait; nothing was removed." >&2; exit 1; fi
    ids="$(docker ps -aq --filter label=proofops.run)"
    if [ -n "$ids" ]; then echo "$ids" | xargs docker rm -f; else echo "no leftover workers"; fi
    ;;
  set-daily-limit)
    n="${2:-}"
    case "$n" in ''|*[!0-9]*) echo "usage: set-daily-limit <whole number>" >&2; exit 2;; esac
    mkdir -p /etc/systemd/system/proofops.service.d
    printf '[Service]\nEnvironment=PROOFOPS_MAX_RUNS_PER_DAY=%s\n' "$n" > /etc/systemd/system/proofops.service.d/daily-limit.conf
    systemctl daemon-reload
    systemctl restart proofops
    wait_healthy
    echo "Daily mission cap is now $n. Worst case about \$$(awk -v n="$n" 'BEGIN { printf "%.2f", n * 0.036 }') a day at the planned model's prices."
    ;;
  scripted)
    if [ "${2:-}" != "--confirm" ]; then
      echo "This changes the public demo to the SCRIPTED planner, with no live AI. To go ahead: operator.sh scripted --confirm" >&2
      exit 2
    fi
    bash "$APP/ops/deploy-app.sh" "$(head_sha)" stub "$(deployment)" "$(hostname_)"
    echo "PUBLIC DEMO IS NOW SCRIPTED. The header reads \"Model: scripted planner (no live AI)\" and runs are labelled VULTR_GVISOR_SCRIPTED."
    echo "Do not present these runs as live-model evidence. To go back: operator.sh live"
    ;;
  live)
    if ! bash "$0" key-check; then echo "The key was not accepted, so the demo stays as it is." >&2; exit 1; fi
    bash "$APP/ops/deploy-app.sh" "$(head_sha)" "${2:-$DEFAULT_MODEL}" "$(deployment)" "$(hostname_)"
    echo "PUBLIC DEMO IS NOW LIVE with ${2:-$DEFAULT_MODEL}."
    ;;
  rollback)
    sha="${2:?usage: rollback <sha>}"
    mode="$(env_value PROOFOPS_PLANNER)"
    bash "$APP/ops/deploy-app.sh" "$sha" "$([ "$mode" = vultr ] && env_value PROOFOPS_MODEL || echo stub)" "$(deployment)" "$(hostname_)"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
