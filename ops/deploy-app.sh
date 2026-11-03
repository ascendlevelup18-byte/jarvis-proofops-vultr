#!/usr/bin/env bash
# Deploys ProofOps on a VM already prepared by ops/vm-bootstrap.sh. NOT YET RUN.
# Usage (as root on the VM): bash deploy-app.sh <git-ref> <model-id> <deployment-label> <hostname>
# Idempotent: re-running updates the code, rebuilds the worker image and restarts the service.
set -euo pipefail
REF="${1:?git ref}"; MODEL="${2:?model id}"; DEPLOYMENT="${3:?deployment label, e.g. vultr:<instance-id>}"; HOSTNAME_="${4:?hostname, e.g. 1-2-3-4.sslip.io}"
APP=/opt/proofops/app
[ -f /etc/proofops/inference.env ] || { echo "inference key not installed yet (run ops/set-inference-key.ps1 from the PC)"; exit 1; }

install -d -m 755 -o proofops -g proofops /opt/proofops /var/lib/proofops /var/lib/proofops/evidence /var/lib/proofops/data
if [ ! -d "$APP/.git" ]; then
  echo "expected $APP to be a git checkout uploaded from the PC (private repo; no credentials on the VM)"; exit 1
fi
sudo -u proofops git -C "$APP" checkout --detach "$REF"
sudo -u proofops bash -c "cd $APP && npm ci --no-audit --no-fund && (cd apps/proofops/worker && npm ci --no-audit --no-fund)"

# Worker image, pinned to the Playwright version in apps/proofops/worker/package.json.
docker build -t proofops-worker:1.64.1 "$APP/apps/proofops/worker"

printf 'PROOFOPS_MODEL=%s\nPROOFOPS_DEPLOYMENT=%s\n' "$MODEL" "$DEPLOYMENT" > /etc/proofops/control.env
chown root:proofops /etc/proofops/control.env && chmod 640 /etc/proofops/control.env
install -m 644 "$APP/ops/proofops.service" /etc/systemd/system/proofops.service
install -m 644 "$APP/ops/Caddyfile" /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=PROOFOPS_HOSTNAME=%s\n' "$HOSTNAME_" > /etc/systemd/system/caddy.service.d/proofops.conf
systemctl daemon-reload
systemctl enable --now proofops
systemctl restart caddy

echo "--- verification"
sleep 3
curl -fsS http://127.0.0.1:4317/api/health
echo
systemctl is-active proofops caddy
