#!/bin/sh
# Runs INSIDE the throwaway container. /task is mounted read-only and
# contains repo/ and poc.js. We copy the repo to a writable tmpfs, start
# the target server if required, run the PoC, then stop everything.
set -u

WORK=/tmp/work
cp -r /task/repo "$WORK" 2>/dev/null || { echo "PROOFGATE_SIGNAL build=copy_failed"; exit 90; }
cd "$WORK" || exit 91

# Build step (no network available; only succeeds for zero-dependency or
# vendored projects, which is correct for the demo fixture).
if [ -f package.json ] && grep -q '"dependencies"' package.json; then
  echo "PROOFGATE_SIGNAL build=npm_install_attempt"
  npm install --no-audit --no-fund --offline >/tmp/npm.log 2>&1 \
    && echo "PROOFGATE_SIGNAL build=ok" \
    || echo "PROOFGATE_SIGNAL build=skipped_no_network"
else
  echo "PROOFGATE_SIGNAL build=none_required"
fi

SERVER_PID=""
if [ "${NEEDS_SERVER:-0}" = "1" ]; then
  node server.js >/tmp/server.log 2>&1 &
  SERVER_PID=$!
  # Wait for /health on loopback (loopback works even with --network none).
  i=0
  while [ $i -lt 40 ]; do
    if wget -q -O- http://127.0.0.1:3000/health >/dev/null 2>&1; then
      echo "PROOFGATE_SIGNAL server=up"
      break
    fi
    i=$((i + 1))
    sleep 0.25
  done
  if [ $i -ge 40 ]; then echo "PROOFGATE_SIGNAL server=failed_to_start"; fi
fi

echo "PROOFGATE_SIGNAL poc=start"
node /task/poc.js
POC_CODE=$?
echo "PROOFGATE_SIGNAL poc_exit=$POC_CODE"

if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; fi
exit $POC_CODE
