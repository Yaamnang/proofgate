'use strict';

// ---- element refs ----
const $ = (id) => document.getElementById(id);
const queueEl = $('queue');
const consoleEl = $('console');
const claimsEl = $('claims');
const blocksEl = $('blocks');
const capsLineEl = $('capsLine');
const verdictBadge = $('verdictBadge');
const verdictSummary = $('verdictSummary');
const adversarialEl = $('adversarial');
const downloadBtn = $('downloadBtn');
const rerunBtn = $('rerunBtn');
const rerunNote = $('rerunNote');
const activeReportEl = $('activeReport');

let currentId = null;        // report currently selected
let currentES = null;        // active EventSource
let lastVerdict = null;      // verdict from the previous run (for rerun compare)
let isRerun = false;
const claimState = {};       // index -> {text,type,target,static}

// ---- helpers ----
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function logLine(line, cls) {
  const span = document.createElement('span');
  const text = String(line || '');
  let klass = 'l-dim';
  if (/^\[sandbox\]/.test(text)) klass = 'l-sandbox';
  else if (/PROOFGATE_SIGNAL/.test(text)) klass = 'l-signal';
  else if (/^\[stage\]/.test(text)) klass = 'l-stage';
  if (cls) klass = cls;
  span.className = klass;
  span.textContent = text + '\n';
  consoleEl.appendChild(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
function clearRun() {
  consoleEl.innerHTML = '';
  claimsEl.innerHTML = '<div class="empty">Extracting claims…</div>';
  blocksEl.innerHTML = '';
  capsLineEl.textContent = '';
  adversarialEl.innerHTML = '<div class="empty">not run yet</div>';
  for (const k in claimState) delete claimState[k];
  document.querySelectorAll('.guard').forEach((g) => g.classList.remove('on'));
  document.querySelectorAll('.stage').forEach((s) => s.classList.remove('active', 'done'));
  setVerdict('running', 'RUNNING…', 'Verifying in a fresh sandbox…');
  downloadBtn.classList.add('disabled');
  downloadBtn.href = '#';
}
function setVerdict(stateClass, label, summary) {
  verdictBadge.className = 'verdict-badge ' + stateClass;
  verdictBadge.textContent = label;
  if (summary != null) verdictSummary.textContent = summary;
}

// ---- config / header ----
async function loadConfig() {
  try {
    const c = await (await fetch('/api/config')).json();
    $('envModel').textContent = c.model || 'unknown';
    $('envRuntime').textContent = c.runtime || 'runc';
    $('runtimeChip').textContent = c.runtime || 'runc';
    const inf = $('envInference');
    if (c.inferenceConfigured) { inf.textContent = 'live'; inf.classList.add('ok'); }
    else { inf.textContent = 'heuristic'; inf.classList.add('warn'); }
  } catch (e) {
    $('envModel').textContent = 'offline';
  }
}

// ---- report queue ----
async function loadReports() {
  try {
    const reports = await (await fetch('/api/reports')).json();
    queueEl.innerHTML = '';
    reports.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'report';
      div.id = 'report-' + r.id;
      div.innerHTML =
        '<div class="report-top">' +
          '<span class="id-badge">' + esc(r.id) + '</span>' +
          '<span class="report-title">' + esc(r.title) + '</span>' +
        '</div>' +
        '<div class="report-meta">' +
          '<span class="sev sev-' + esc((r.severity || 'low').toLowerCase()) + '">' + esc(r.severity || '') + '</span>' +
          (r.hostile ? '<span class="tag-hostile">hostile</span>' : '') +
        '</div>';
      div.addEventListener('click', () => startVerify(r.id, false));
      queueEl.appendChild(div);
    });
  } catch (e) {
    queueEl.innerHTML = '<div class="empty">Could not load reports.</div>';
  }
}

// ---- verification run ----
function startVerify(id, rerun) {
  if (currentES) { try { currentES.close(); } catch (e) {} currentES = null; }
  isRerun = !!rerun;
  currentId = id;

  document.querySelectorAll('.report').forEach((el) => el.classList.remove('active', 'running'));
  const row = $('report-' + id);
  if (row) { row.classList.add('active', 'running'); }
  activeReportEl.textContent = 'report ' + id;
  rerunBtn.disabled = true;
  rerunNote.textContent = '';
  rerunNote.className = 'rerun-note';
  clearRun();
  if (rerun) logLine('[stage] re-running in a brand-new sandbox to confirm independently', 'l-stage');

  const es = new EventSource('/api/verify/' + encodeURIComponent(id));
  currentES = es;

  es.addEventListener('stage', (e) => {
    const d = safe(e.data);
    if (!d || !d.stage) return;
    const el = document.querySelector('.stage[data-s="' + d.stage + '"]');
    if (el) {
      if (d.status === 'done') { el.classList.remove('active'); el.classList.add('done'); }
      else { el.classList.add('active'); }
    }
    if (d.detail) logLine('[stage] ' + d.stage + ': ' + d.detail, 'l-stage');
  });

  es.addEventListener('log', (e) => {
    const d = safe(e.data);
    if (d && d.line != null) logLine(d.line);
  });

  es.addEventListener('claim', (e) => {
    const d = safe(e.data);
    if (!d || d.index == null) return;
    claimState[d.index] = Object.assign(claimState[d.index] || {}, d);
    renderClaims();
  });

  es.addEventListener('containment', (e) => {
    const c = safe(e.data);
    if (!c) return;
    lightGuard('network', c.network === 'none');
    lightGuard('secrets', c.secretsMounted === false);
    lightGuard('user', !!c.user && /non-root/.test(c.user));
    lightGuard('rootfs', c.readOnlyRootfs === true);
    lightGuard('caps', true);
    lightGuard('destroy', c.destroyedAfter === true);
    $('runtimeChip').textContent = c.runtime || 'runc';
    capsLineEl.textContent =
      'cpu ' + (c.cpu || '?') + '  ·  mem ' + (c.memory || '?') +
      '  ·  pids ' + (c.pids || '?') + '  ·  timeout ' + (c.timeoutSeconds || '?') + 's' +
      '  ·  caps ' + (c.capabilities || 'dropped');
  });

  es.addEventListener('observed', (e) => {
    const o = safe(e.data);
    if (!o) return;
    blocksEl.innerHTML = '';
    if (o.outboundBlocked) addBlock('⛔ outbound connection blocked');
    if (o.secretFileBlocked) addBlock('⛔ secret read blocked');
    if (o.outboundAttempted && !o.outboundBlocked) addBlock('⚠ outbound connection SUCCEEDED');
  });

  es.addEventListener('verdict', (e) => {
    const v = safe(e.data);
    if (!v) return;
    renderVerdict(v);
  });

  es.addEventListener('done', (e) => {
    const d = safe(e.data) || {};
    if (d.evidenceId) {
      downloadBtn.classList.remove('disabled');
      downloadBtn.href = '/api/evidence/' + encodeURIComponent(d.evidenceId) + '.zip';
    }
    rerunBtn.disabled = false;
    if (row) row.classList.remove('running');
    es.close(); currentES = null;
  });

  es.addEventListener('error', (e) => {
    const d = safe(e.data);
    if (d && d.message) {
      logLine('[error] ' + d.message, 'l-stage');
      setVerdict('INCONCLUSIVE', 'ERROR', d.message);
    } else if (es.readyState === EventSource.CLOSED) {
      logLine('[error] stream closed', 'l-dim');
    }
    rerunBtn.disabled = false;
    if (row) row.classList.remove('running');
    try { es.close(); } catch (x) {}
    currentES = null;
  });
}

function lightGuard(key, on) {
  const el = document.querySelector('.guard[data-k="' + key + '"]');
  if (el && on) el.classList.add('on');
}
function addBlock(text) {
  const d = document.createElement('div');
  d.className = 'block-alert';
  d.textContent = text;
  blocksEl.appendChild(d);
}

function renderClaims() {
  const keys = Object.keys(claimState).sort((a, b) => a - b);
  if (!keys.length) { claimsEl.innerHTML = '<div class="empty">No claims yet.</div>'; return; }
  claimsEl.innerHTML = '';
  keys.forEach((k) => {
    const c = claimState[k];
    const st = c.static || {};
    const div = document.createElement('div');
    div.className = 'claim';
    let foot = '<span class="claim-type">' + esc(c.type || 'behavior') + '</span>';
    if (st.status) foot += '<span class="pill ' + esc(st.status) + '">' + esc(st.status) + '</span>';
    div.innerHTML =
      '<div class="claim-text">' + esc(c.text || '') + '</div>' +
      '<div class="claim-foot">' + foot + '</div>' +
      (st.detail ? '<div class="claim-reason">' + esc(st.detail) + '</div>' : '');
    claimsEl.appendChild(div);
  });
}

function renderVerdict(v) {
  const state = v.verdict || 'INCONCLUSIVE';
  setVerdict(state, state, v.summary || '');

  // Per-claim verdicts (override static pills with final reasoning)
  if (Array.isArray(v.perClaim) && v.perClaim.length) {
    claimsEl.innerHTML = '';
    v.perClaim.forEach((pc) => {
      const div = document.createElement('div');
      div.className = 'claim';
      div.innerHTML =
        '<div class="claim-text">' + esc(pc.text || '') + '</div>' +
        '<div class="claim-foot"><span class="pill ' + esc(pc.verdict || 'unknown') + '">' +
          esc(pc.verdict || '') + '</span></div>' +
        (pc.reason ? '<div class="claim-reason">' + esc(pc.reason) + '</div>' : '');
      claimsEl.appendChild(div);
    });
  }

  // Adversarial review
  const a = v.adversarial || {};
  let flags = '';
  if (a.securityRelevant != null)
    flags += pill(a.securityRelevant ? 'present' : 'unknown', a.securityRelevant ? 'security-relevant' : 'not security-relevant');
  if (a.needsUnrealisticConditions)
    flags += pill('absent', 'needs unrealistic conditions');
  if (a.contradicted)
    flags += pill('CONTRADICTED', 'contradicted by code');
  adversarialEl.innerHTML =
    (flags ? '<div class="adv-flags">' + flags + '</div>' : '') +
    '<div class="adv-rationale">' + esc(a.rationale || 'No adversarial rationale provided.') + '</div>';

  // Rerun comparison
  if (isRerun && lastVerdict) {
    if (lastVerdict === state) {
      rerunNote.textContent = '✓ Independent re-run produced the same verdict: ' + state;
      rerunNote.className = 'rerun-note match';
    } else {
      rerunNote.textContent = '⚠ Re-run differed: was ' + lastVerdict + ', now ' + state;
      rerunNote.className = 'rerun-note mismatch';
    }
  }
  lastVerdict = state;
}

function pill(cls, label) {
  return '<span class="pill ' + esc(cls) + '">' + esc(label) + '</span>';
}
function safe(data) {
  try { return JSON.parse(data); } catch (e) { return null; }
}

rerunBtn.addEventListener('click', () => {
  if (currentId) startVerify(currentId, true);
});

loadConfig();
loadReports();
