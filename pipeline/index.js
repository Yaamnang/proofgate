// pipeline/index.js
// Orchestrates the full verification for one report and emits live events
// in a fixed order. Concrete sandbox signals drive the verdict; the LLM
// passes add claim structure and adversarial judgement.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const agent = require('../agent');
const { runTask } = require('../sandbox/runner');
const { decideVerdict } = require('./verdict');
const { buildEvidence } = require('./evidence');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

// Clone the report's repo bundle at the exact commit into a temp dir so the
// static checks and the evidence package look at precisely what ran.
function cloneRepo(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-static-' + report.id + '-'));
  const repoDir = path.join(dir, 'repo');
  const bundle = path.join(FIXTURES, report.repo);
  execSync(`git clone --quiet "${bundle}" "${repoDir}"`, { stdio: 'ignore' });
  execSync(`git -C "${repoDir}" checkout --quiet ${report.commit}`, { stdio: 'ignore' });
  return { dir, repoDir };
}

async function verify(report, emit) {
  let temp = null;
  try {
    // 1. Claim extraction ---------------------------------------------------
    emit('stage', { stage: 'extract', status: 'start', label: 'Extracting claims' });
    const claims = await agent.extractClaims(report);
    claims.forEach((claim, index) => {
      emit('claim', { index, text: claim.text, type: claim.type, target: claim.target });
    });
    emit('stage', {
      stage: 'extract',
      status: 'done',
      label: 'Extracting claims',
      detail: `${claims.length} claim${claims.length === 1 ? '' : 's'}`,
    });

    // 2. Static checks ------------------------------------------------------
    emit('stage', { stage: 'static', status: 'start', label: 'Static checks' });
    temp = cloneRepo(report);
    const staticResults = claims.map((claim, index) => {
      const result = agent.staticCheck(claim, temp.repoDir);
      emit('claim', {
        index,
        text: claim.text,
        type: claim.type,
        target: claim.target,
        static: result,
      });
      return { claim, result };
    });
    const absent = staticResults.filter((s) => s.result.status === 'absent').length;
    emit('stage', {
      stage: 'static',
      status: 'done',
      label: 'Static checks',
      detail: absent ? `${absent} claim(s) fail — named code missing` : 'named code present',
    });

    // 3. Dynamic reproduction (sandbox) ------------------------------------
    emit('stage', { stage: 'dynamic', status: 'start', label: 'Dynamic reproduction' });
    const sandbox = await runTask(report, (line) => emit('log', { line }));
    emit('containment', sandbox.containment);
    emit('observed', sandbox.observed);
    emit('stage', {
      stage: 'dynamic',
      status: 'done',
      label: 'Dynamic reproduction',
      detail: `exit ${sandbox.observed.pocExit} in ${sandbox.durationMs}ms`,
    });

    // 4. Adversarial pass ---------------------------------------------------
    emit('stage', { stage: 'adversarial', status: 'start', label: 'Adversarial review' });
    const adversarial = await agent.adversarialJudge({
      report,
      observed: sandbox.observed,
      claims,
      staticResults,
      sandbox,
    });
    emit('stage', {
      stage: 'adversarial',
      status: 'done',
      label: 'Adversarial review',
      detail: adversarial.rationale,
    });

    // 5. Verdict ------------------------------------------------------------
    emit('stage', { stage: 'verdict', status: 'start', label: 'Deciding verdict' });
    const v = decideVerdict({ report, claims, staticResults, sandbox, adversarial });
    emit('stage', { stage: 'verdict', status: 'done', label: 'Deciding verdict', detail: v.verdict });

    // 6. Evidence package ---------------------------------------------------
    emit('stage', { stage: 'evidence', status: 'start', label: 'Packaging evidence' });
    const ev = await buildEvidence({
      report,
      repoDir: temp.repoDir,
      sandbox,
      verdict: v,
      claims,
    });
    emit('stage', {
      stage: 'evidence',
      status: 'done',
      label: 'Packaging evidence',
      detail: ev.evidenceId,
    });

    emit('verdict', {
      id: report.id,
      verdict: v.verdict,
      perClaim: v.perClaim,
      summary: v.summary,
      adversarial,
      evidenceId: ev.evidenceId,
      durationMs: sandbox.durationMs,
    });
    emit('done', { evidenceId: ev.evidenceId });
    return { verdict: v.verdict, evidenceId: ev.evidenceId };
  } catch (err) {
    emit('error', { message: err && err.message ? err.message : String(err) });
    throw err;
  } finally {
    if (temp) {
      try {
        fs.rmSync(temp.dir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

module.exports = { verify, cloneRepo };
