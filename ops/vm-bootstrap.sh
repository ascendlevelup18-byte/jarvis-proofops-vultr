#!/usr/bin/env bash
# ProofOps VM bootstrap for Ubuntu 24.04 LTS on Vultr. NOT YET RUN: it runs only after the owner approves the VM
# and the build window has started. It is idempotent and prints what it verified.
# Installs Docker, gVisor (runsc), Node 24 and Caddy; creates service users; enables a default-deny firewall.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = "24.04" ] || { echo "expected Ubuntu 24.04, found $PRETTY_NAME"; exit 1; }
[ "$(dpkg --print-architecture)" = amd64 ] || { echo "expected amd64"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# SSH: key-only login. Vultr also sets a root password; it must never work over SSH.
install -d /etc/ssh/sshd_config.d
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-proofops.conf
sshd -t && systemctl reload ssh

apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw jq sqlite3 git xz-utils

# Docker Engine (official repository)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

# gVisor (official repository)
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list

# Caddy (official repository)
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list

# Node.js: pinned official release, verified against nodejs.org's published checksums (no piped install script).
NODE_VERSION=v24.20.0
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  expected="$(grep " node-$NODE_VERSION-linux-x64.tar.xz$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  echo "$expected  $tmp/node.tar.xz" | sha256sum -c -
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io runsc caddy

# Register gVisor with Docker using the systrap platform. host-uds=open lets the sandbox connect to the
# per-run proxy socket we bind-mount; it must be verified by the boundary tests, not assumed.
runsc install --runtime runsc -- --platform=systrap --host-uds=open
systemctl restart docker

# Service users: the control plane, the approval signer and the verifier run as different users.
for u in proofops proofops-approver proofops-verifier; do id "$u" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$u"; done
# Known risk, disclosed in the README: docker group membership is root-equivalent on the host, so the control
# plane is a high-value process. The worker never gets the Docker socket.
usermod -aG docker proofops          # only the control plane may start workers
install -d -m 750 -o proofops -g proofops /var/lib/proofops /etc/proofops

# Firewall: SSH, HTTP and HTTPS only. Everything else inbound is dropped.
# Docker-published ports bypass ufw, so ProofOps never uses `docker run -p`; services bind 127.0.0.1 behind Caddy.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Verification printout (evidence for the bootstrap step)
echo "--- verification"
echo "os: $PRETTY_NAME"
sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin) '
docker version --format 'docker: {{.Server.Version}}'
docker info --format 'runtimes: {{range $k, $v := .Runtimes}}{{$k}} {{end}}'
runsc --version | head -1
/usr/local/bin/node --version
caddy version
ufw status | head -8
docker run --rm --runtime=runsc hello-world >/dev/null && echo "gvisor: hello-world ran under runsc"
