// pipeline/evidence.js
// Writes a self-contained, independently re-runnable evidence package for
// one verification, then zips it. The maintainer can unzip and run
// ./rerun.sh to reproduce the verdict in a brand-new sandbox, trusting the
// proof rather than the AI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const SANDBOX_DIR = path.join(ROOT, 'sandbox');
const EVIDENCE_ROOT = path.join(ROOT, 'evidence');

const MEM = process.env.SANDBOX_MEM || '512m';
const CPUS = process.env.SANDBOX_CPUS || '1.0';
const PIDS = process.env.SANDBOX_PIDS || '256';
const TIMEOUT_S = parseInt(process.env.SANDBOX_TIMEOUT || '45', 10);
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'node:22-alpine';

function rerunScript(report, verdict) {
  const needsServer = report.poc && report.poc.needsServer ? '1' : '0';
  // Mirrors the containment flags in sandbox/runner.js exactly.
  return `#!/bin/sh
# ProofGate evidence re-run. Reproduces the verdict for report ${report.id}
# in a brand-new, locked-down container. Requires only Docker.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[rerun] cloning repo at commit ${report.commit}"
git clone --quiet "$HERE/repo.bundle" "$WORK/repo"
git -C "$WORK/repo" checkout --quiet ${report.commit}
cp "$HERE/poc.js" "$WORK/poc.js"
cp "$HERE/run.sh" "$WORK/run.sh"
chmod -R a+rX "$WORK"

RUNTIME_FLAG=""
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q runsc; then
  RUNTIME_FLAG="--runtime runsc"
fi

echo "[rerun] running sandbox (network none, read-only, non-root, caps enforced)"
docker run --rm --init --network none \\
  --memory ${MEM} --memory-swap ${MEM} --cpus ${CPUS} --pids-limit ${PIDS} \\
  --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \\
  --read-only --tmpfs /tmp:rw,exec,size=128m \\
  -e NEEDS_SERVER=${needsServer} \\
  -v "$WORK:/task:ro" -w /task $RUNTIME_FLAG \\
  ${RUNNER_IMAGE} sh /task/run.sh

echo ""
echo "[rerun] Compare the PROOFGATE_SIGNAL lines above with expected-vs-actual.json."
echo "[rerun] ProofGate verdict for report ${report.id}: ${verdict.verdict}"
`;
}

function readmeText(report, verdict, sandbox) {
  return `# ProofGate evidence — report ${report.id}

Title: ${report.title}
Commit: ${report.commit}
Verdict: ${verdict.verdict}
Summary: ${verdict.summary}

## Reproduce it yourself
You do not have to trust the verdict. Reproduce it in a fresh sandbox:

    ./rerun.sh

Requires Docker. The script clones the exact commit from repo.bundle,
stages the same PoC, and runs it under the same containment
(--network none, --read-only, --cap-drop ALL, non-root uid 1000,
cpu/mem/pids caps${sandbox.containment.runtime.includes('gVisor') ? ', gVisor' : ''}).
Compare the printed PROOFGATE_SIGNAL lines with expected-vs-actual.json.

## Contents
- report.json ............ the original report
- commit.txt ............. the verified commit hash
- poc.js ................. the proof-of-concept that was executed
- run.sh ................. the in-container runner
- repo.bundle ............ the target repo (git bundle), clone-able offline
- raw-output.log ......... full captured sandbox output
- expected-vs-actual.json  per-signal expected vs observed
- verdict.json ........... final verdict and per-claim breakdown
- rerun.sh ............... one-command independent reproduction

Built with AI assistance.
`;
}

async function buildEvidence({ report, repoDir, sandbox, verdict, claims }) {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const evidenceId = `${report.id}-${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  const dir = path.join(EVIDENCE_ROOT, evidenceId);
  fs.mkdirSync(dir, { recursive: true });

  // Core artifacts.
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'commit.txt'), report.commit + '\n');
  fs.copyFileSync(path.join(FIXTURES, 'reports', report.poc.file), path.join(dir, 'poc.js'));
  fs.copyFileSync(path.join(SANDBOX_DIR, 'run.sh'), path.join(dir, 'run.sh'));
  fs.copyFileSync(path.join(FIXTURES, report.repo), path.join(dir, 'repo.bundle'));
  fs.writeFileSync(path.join(dir, 'raw-output.log'), sandbox.rawOutput || '');

  const expectedVsActual = {
    reportId: report.id,
    declaredExpected: report.expected || '(not declared)',
    finalVerdict: verdict.verdict,
    observed: sandbox.observed,
    signals: sandbox.signals,
    containment: sandbox.containment,
    durationMs: sandbox.durationMs,
  };
  fs.writeFileSync(
    path.join(dir, 'expected-vs-actual.json'),
    JSON.stringify(expectedVsActual, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'verdict.json'),
    JSON.stringify({ ...verdict, claims, adversarialAt: new Date().toISOString() }, null, 2)
  );

  // One-command reproduction.
  const rerunPath = path.join(dir, 'rerun.sh');
  fs.writeFileSync(rerunPath, rerunScript(report, verdict));
  fs.chmodSync(rerunPath, 0o755);
  fs.writeFileSync(path.join(dir, 'README.md'), readmeText(report, verdict, sandbox));

  // Zip it. Prefer zip; fall back to tar.gz under a .zip name if absent.
  const zipPath = path.join(EVIDENCE_ROOT, evidenceId + '.zip');
  try {
    execSync(`cd "${EVIDENCE_ROOT}" && zip -r -q "${evidenceId}.zip" "${evidenceId}"`, {
      stdio: 'ignore',
    });
  } catch (_) {
    try {
      execSync(`cd "${EVIDENCE_ROOT}" && tar czf "${evidenceId}.zip" "${evidenceId}"`, {
        stdio: 'ignore',
      });
    } catch (e) {
      console.error('[evidence] packaging failed: ' + e.message);
    }
  }

  return { evidenceId, dir, zipPath };
}

module.exports = { buildEvidence };
