// sandbox/runner.js
// Spins up a fresh, locked-down Docker container for one verification
// task, runs the supplied PoC inside it, captures everything, and
// destroys the container. This is the containment core of ProofGate.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'node:22-alpine';
const MEM = process.env.SANDBOX_MEM || '512m';
const CPUS = process.env.SANDBOX_CPUS || '1.0';
const PIDS = process.env.SANDBOX_PIDS || '256';
const TIMEOUT_S = parseInt(process.env.SANDBOX_TIMEOUT || '45', 10);
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const SANDBOX_DIR = __dirname;

// Detect whether the gVisor runtime (runsc) is registered with Docker.
function detectRuntime() {
  try {
    const out = execSync('docker info --format "{{json .Runtimes}}" 2>/dev/null', {
      encoding: 'utf8',
    });
    if (out && out.includes('runsc')) return 'runsc';
  } catch (_) {}
  return 'runc';
}

const RUNTIME = detectRuntime();

function sh(cmd, args) {
  try {
    execSync([cmd, ...args].join(' '), { stdio: 'ignore' });
  } catch (_) {}
}

// Prepare an isolated host workspace: clone the repo bundle at the exact
// commit and stage the PoC next to it.
function prepareTask(report) {
  const id = crypto.randomBytes(5).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-' + report.id + '-'));
  const bundle = path.join(FIXTURES, report.repo);
  execSync(`git clone --quiet "${bundle}" "${path.join(dir, 'repo')}"`, { stdio: 'ignore' });
  execSync(`git -C "${path.join(dir, 'repo')}" checkout --quiet ${report.commit}`, {
    stdio: 'ignore',
  });
  fs.copyFileSync(path.join(FIXTURES, 'reports', report.poc.file), path.join(dir, 'poc.js'));
  fs.copyFileSync(path.join(SANDBOX_DIR, 'run.sh'), path.join(dir, 'run.sh'));
  // The container runs as uid 1000; make the staged files world-readable
  // so the non-root sandbox user can read the repo, PoC and run script.
  execSync(`chmod -R a+rX "${dir}"`, { stdio: 'ignore' });
  return { id, dir };
}

// The containment profile applied to every run, also reported to the UI.
function containmentProfile() {
  return {
    network: 'none',
    secretsMounted: false,
    user: 'non-root (uid 1000)',
    readOnlyRootfs: true,
    capabilities: 'all dropped',
    noNewPrivileges: true,
    cpu: CPUS,
    memory: MEM,
    pids: PIDS,
    timeoutSeconds: TIMEOUT_S,
    runtime: RUNTIME === 'runsc' ? 'gVisor (runsc)' : 'runc + hardening flags',
    destroyedAfter: true,
  };
}

function dockerArgs(containerName, taskDir, needsServer) {
  const args = [
    'run',
    '--rm',
    '--name', containerName,
    '--init',
    '--network', 'none',
    '--memory', MEM,
    '--memory-swap', MEM,
    '--cpus', CPUS,
    '--pids-limit', PIDS,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '1000:1000',
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=128m',
    '-e', 'NEEDS_SERVER=' + (needsServer ? '1' : '0'),
    '-v', `${taskDir}:/task:ro`,
    '-w', '/task',
  ];
  if (RUNTIME === 'runsc') args.push('--runtime', 'runsc');
  args.push(RUNNER_IMAGE, 'sh', '/task/run.sh');
  return args;
}

// Parse PROOFGATE_SIGNAL lines the PoC/run.sh emit into a flat object.
function parseSignals(output) {
  const signals = {};
  const re = /PROOFGATE_SIGNAL\s+([^\s=]+)=?(.*)/g;
  let m;
  while ((m = re.exec(output)) !== null) {
    const key = m[1];
    let val = (m[2] || '').trim();
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    signals[key] = val === '' ? true : val;
  }
  return signals;
}

// Run one task to completion. onLog(line) streams live output.
async function runTask(report, onLog = () => {}) {
  const containment = containmentProfile();
  const { id, dir } = prepareTask(report);
  const containerName = 'pg_' + report.id + '_' + id;
  const needsServer = !!(report.poc && report.poc.needsServer);

  onLog(`[sandbox] fresh container ${containerName}`);
  onLog(`[sandbox] runtime=${containment.runtime}`);
  onLog(`[sandbox] network=none  secrets=none  user=non-root  rootfs=read-only`);
  onLog(`[sandbox] caps: cpu=${CPUS} mem=${MEM} pids=${PIDS} timeout=${TIMEOUT_S}s`);

  const args = dockerArgs(containerName, dir, needsServer);
  const started = Date.now();

  const result = await new Promise((resolve) => {
    const child = spawn('docker', args);
    let out = '';
    let timedOut = false;

    const killer = setTimeout(() => {
      timedOut = true;
      onLog('[sandbox] hard timeout reached, killing container');
      sh('docker', ['kill', containerName]);
    }, (TIMEOUT_S + 5) * 1000);

    function handle(buf) {
      const text = buf.toString();
      out += text;
      text.split(/\r?\n/).forEach((line) => {
        if (line.trim()) onLog(line);
      });
    }
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, out, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ code: -1, out: out + '\n[sandbox] spawn error: ' + err.message, timedOut });
    });
  });

  // Guaranteed teardown.
  sh('docker', ['rm', '-f', containerName]);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  onLog(`[sandbox] container destroyed`);

  const signals = parseSignals(result.out);
  const durationMs = Date.now() - started;

  // Derive observable containment outcomes for the UI.
  const outboundBlocked =
    'exfil_blocked' in signals || /exfil_blocked/.test(result.out);
  const outboundSucceeded = signals.exfil === 'OK';
  const secretFileBlocked = /secret_file_blocked/.test(result.out);

  return {
    containment,
    containerName,
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs,
    rawOutput: result.out,
    signals,
    observed: {
      secretRead: signals.secret_read === true,
      boundaryCrossed: signals.boundary_crossed === true,
      serverUp: signals.server === 'up',
      pocExit: signals.poc_exit !== undefined ? parseInt(signals.poc_exit, 10) : result.code,
      crash: signals.crash === true,
      outboundAttempted: outboundBlocked || outboundSucceeded,
      outboundBlocked: outboundBlocked && !outboundSucceeded,
      secretFileBlocked,
    },
  };
}

module.exports = { runTask, containmentProfile, detectRuntime, RUNTIME };
