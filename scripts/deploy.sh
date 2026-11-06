#!/usr/bin/env bash
# ProofGate deploy script for a fresh Vultr Cloud Compute VM.
# Target: Ubuntu 24.04, 2+ vCPU, 4GB+ RAM, no GPU.
# Run as a user with sudo, from inside the cloned repo:
#   git clone <your-repo-url> proofgate && cd proofgate
#   bash scripts/deploy.sh
# Idempotent: safe to run more than once.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
echo "==> ProofGate deploy from $REPO_DIR"

# --- 1. System packages -----------------------------------------------
echo "==> Updating apt and installing base packages"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git zip ufw

# --- 2. Docker ---------------------------------------------------------
# The sandbox runs every PoC in a throwaway Docker container, so Docker
# is required on the VM. ProofGate is the only thing that talks to it.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker via get.docker.com"
  curl -fsSL https://get.docker.com | sudo sh
else
  echo "==> Docker already installed, skipping"
fi
sudo systemctl enable --now docker
# Let the current user run docker without sudo (takes effect on next login;
# this script uses sudo docker where it needs the daemon immediately).
sudo usermod -aG docker "$USER" || true

# --- 3. Node.js 22 -----------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  echo "==> Installing Node.js 22 via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "==> Node $(node -v) already installed, skipping"
fi

# --- 4. Optional: gVisor (runsc) --------------------------------------
# gVisor gives each container a user-space kernel for stronger isolation.
# ProofGate uses it automatically if present, else falls back to runc with
# hardening flags. This block is best-effort and will not fail the deploy.
if ! command -v runsc >/dev/null 2>&1; then
  echo "==> Attempting best-effort gVisor (runsc) install"
  if (
    set -e
    curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
    sudo apt-get update -y
    sudo apt-get install -y runsc
    sudo runsc install
    sudo systemctl restart docker
  ); then
    echo "==> gVisor installed and registered with Docker"
  else
    echo "==> gVisor install skipped (not fatal). Using runc with hardening flags."
  fi
else
  echo "==> gVisor (runsc) already present"
fi

# --- 5. App dependencies and runner image ------------------------------
echo "==> Installing npm dependencies"
npm install --no-audit --no-fund

echo "==> Pulling sandbox runner image"
# shellcheck disable=SC1091
RUNNER_IMAGE_DEFAULT="node:22-alpine"
RUNNER_IMAGE_VAL="$RUNNER_IMAGE_DEFAULT"
if [ -f .env ]; then
  ENV_IMG="$(grep -E '^RUNNER_IMAGE=' .env | cut -d= -f2- || true)"
  [ -n "${ENV_IMG:-}" ] && RUNNER_IMAGE_VAL="$ENV_IMG"
fi
sudo docker pull "$RUNNER_IMAGE_VAL"

# --- 6. .env setup -----------------------------------------------------
if [ ! -f .env ]; then
  echo "==> Creating .env from template"
  cp .env.example .env
  echo
  echo "    IMPORTANT: edit .env and set VULTR_INFERENCE_API_KEY before starting."
  echo "    nano .env"
  echo
fi

# --- 7. Firewall -------------------------------------------------------
PORT_VAL="$(grep -E '^PORT=' .env | cut -d= -f2- || true)"
PORT_VAL="${PORT_VAL:-3000}"
echo "==> Opening firewall on port $PORT_VAL and SSH"
sudo ufw allow OpenSSH || true
sudo ufw allow "${PORT_VAL}/tcp" || true
sudo ufw --force enable || true

# --- 8. Start ----------------------------------------------------------
cat <<EOF

==> Deploy complete.

Start ProofGate now (foreground):
    npm start

Or run it in the background:
    nohup npm start > proofgate.log 2>&1 &

Or install it as a systemd service (recommended for a VM):
    sudo tee /etc/systemd/system/proofgate.service >/dev/null <<UNIT
    [Unit]
    Description=ProofGate
    After=network.target docker.service
    Requires=docker.service

    [Service]
    WorkingDirectory=$REPO_DIR
    EnvironmentFile=$REPO_DIR/.env
    ExecStart=$(command -v node) $REPO_DIR/server.js
    Restart=on-failure
    User=$USER

    [Install]
    WantedBy=multi-user.target
    UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable --now proofgate

Then open:  http://<YOUR_VM_IP>:${PORT_VAL}

Note: you may need to log out and back in once for docker group membership
to take effect so you can run docker without sudo.
EOF
