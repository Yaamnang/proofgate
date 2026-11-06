// agent/index.js
// The reasoning layer: claim extraction, static verification, and the
// adversarial pass. LLM calls go through agent/llm.js (Vultr only); every
// LLM path has a deterministic heuristic fallback so the pipeline runs
// even with no API key or a transient API error.

const fs = require('fs');
const path = require('path');
const llm = require('./llm');

const VALID_TYPES = ['file_exists', 'function_exists', 'version', 'behavior'];

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You split a vulnerability report into discrete, independently testable claims.
Return ONLY JSON: {"claims":[{"text":"...","type":"file_exists|function_exists|version|behavior","target":"..."}]}.
- file_exists: the report says a specific source file exists. target = the file path.
- function_exists: the report says a specific function/method exists. target = the function name (no parens).
- version: the report ties the bug to a runtime/dependency version. target = the version expression (e.g. "Node < 18").
- behavior: the claimed exploit behavior/impact. target = "".
Keep claims atomic. Do not invent facts not in the report.`;

async function extractClaimsLLM(report) {
  const content = await llm.chat(
    [
      { role: 'system', content: EXTRACT_SYSTEM },
      {
        role: 'user',
        content: `Report title: ${report.title}\n\nReport body:\n${report.body}`,
      },
    ],
    { temperature: 0, jsonMode: true }
  );
  const parsed = llm.parseJson(content);
  const arr = Array.isArray(parsed) ? parsed : parsed && parsed.claims;
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('no claims parsed');
  return arr
    .filter((c) => c && c.text)
    .map((c) => ({
      text: String(c.text).slice(0, 300),
      type: VALID_TYPES.includes(c.type) ? c.type : 'behavior',
      target: c.target ? String(c.target).replace(/\(\)$/, '').trim() : '',
    }));
}

// Deterministic extraction straight from the report text.
function extractClaimsHeuristic(report) {
  const body = report.body || '';
  const claims = [];
  const seen = new Set();
  const add = (text, type, target) => {
    const key = type + ':' + (target || text);
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ text, type, target: target || '' });
  };

  // Functions named in the report, e.g. "function getNote()" or "getNote()".
  const fnRe = /\b(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\(\)/g;
  let m;
  while ((m = fnRe.exec(body)) !== null) {
    const name = m[1];
    if (['GET', 'POST', 'if', 'for', 'while', 'return'].includes(name)) continue;
    add(`Function ${name}() exists in the codebase`, 'function_exists', name);
  }

  // Source files named, e.g. "server.js", "Affected file: server.js".
  // Skip runtime/product names that happen to end in a code extension
  // (e.g. "Node.js" is a runtime, not a source file in the repo).
  const NON_FILE_TOKENS = new Set(['node.js', 'next.js', 'nest.js', 'nuxt.js', 'vue.js']);
  const fileRe = /\b([A-Za-z0-9_\-/.]+\.(?:js|ts|py|go|rb|java|php|c|cpp|rs))\b/g;
  while ((m = fileRe.exec(body)) !== null) {
    if (NON_FILE_TOKENS.has(m[1].toLowerCase())) continue;
    add(`File ${m[1]} exists at the stated commit`, 'file_exists', m[1]);
  }

  // Version-sensitivity, e.g. "Node < 18", "Node.js versions below 18",
  // "prior to 18". Captures a runtime/dependency version gate.
  const verRe =
    /\b((?:Node(?:\.js)?|Python|PHP|Ruby|Java)?\s*(?:versions?\s*)?(?:<|below|under|prior to)\s*\d+(?:\.\d+)*)\b/i;
  const vm = body.match(verRe);
  if (vm) {
    const expr = vm[1].replace(/\s+/g, ' ').trim();
    add(`Impact is tied to ${expr}`, 'version', expr);
  }

  // The overall behavioral claim is the report title.
  add(report.title || 'Claimed vulnerability behavior', 'behavior', '');

  return claims;
}

async function extractClaims(report) {
  if (llm.available()) {
    try {
      const claims = await extractClaimsLLM(report);
      console.error(`[agent] claim extraction via Vultr inference (${llm.MODEL})`);
      return claims;
    } catch (err) {
      console.error(`[agent] LLM extract failed (${err.code || err.message}); using heuristic`);
    }
  } else {
    console.error('[agent] no inference key; claim extraction via heuristic');
  }
  return extractClaimsHeuristic(report);
}

// ---------------------------------------------------------------------------
// Static verification (pure fs, no LLM)
// ---------------------------------------------------------------------------

function listSourceFiles(dir, acc = [], root = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, acc, root);
    else acc.push(full);
  }
  return acc;
}

function staticCheck(claim, repoDir) {
  try {
    if (claim.type === 'file_exists') {
      const target = claim.target.replace(/^\.?\//, '');
      const direct = path.join(repoDir, target);
      if (fs.existsSync(direct)) return { status: 'present', detail: `${target} found` };
      // Fall back to basename match anywhere in the tree.
      const base = path.basename(target);
      const hit = listSourceFiles(repoDir).find((f) => path.basename(f) === base);
      return hit
        ? { status: 'present', detail: `${base} found at ${path.relative(repoDir, hit)}` }
        : { status: 'absent', detail: `${target} not found in repo` };
    }

    if (claim.type === 'function_exists') {
      const name = claim.target;
      if (!name) return { status: 'unknown', detail: 'no function name given' };
      const patterns = [
        new RegExp(`function\\s+${name}\\b`),
        new RegExp(`\\b${name}\\s*=\\s*(?:async\\s*)?(?:function|\\()`),
        new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?:=>|\\{)`),
        new RegExp(`\\b${name}\\s*:\\s*(?:async\\s*)?function`),
      ];
      for (const file of listSourceFiles(repoDir)) {
        const src = fs.readFileSync(file, 'utf8');
        if (patterns.some((p) => p.test(src))) {
          return { status: 'present', detail: `${name}() defined in ${path.relative(repoDir, file)}` };
        }
      }
      return { status: 'absent', detail: `${name}() not defined anywhere in repo` };
    }

    if (claim.type === 'version') {
      // Runtime-version claims cannot be settled by reading the source.
      return { status: 'unknown', detail: 'runtime-version claim, not statically decidable' };
    }

    return { status: 'unknown', detail: 'behavioral claim, decided by dynamic run' };
  } catch (err) {
    return { status: 'unknown', detail: 'static check error: ' + err.message };
  }
}

// ---------------------------------------------------------------------------
// Adversarial pass — tries to DISPROVE the claimed impact
// ---------------------------------------------------------------------------

const ADVERSARIAL_SYSTEM = `You are a skeptical security reviewer. Your job is to DISPROVE a vulnerability claim.
You are given the report, the observed sandbox signals, and static-check results.
Decide, strictly from the evidence:
- securityRelevant: did the sandbox actually demonstrate security-relevant impact (a boundary crossed, a secret read, a crash that an attacker controls)? Normal, expected behavior is NOT security-relevant.
- needsUnrealisticConditions: did reproduction depend on conditions a real deployment would not have (and that the sandbox could not meet)?
- contradicted: does static evidence show the report's core factual basis is false (named file/function absent)?
Return ONLY JSON: {"securityRelevant":bool,"needsUnrealisticConditions":bool,"contradicted":bool,"rationale":"one sentence"}.`;

function adversarialHeuristic({ observed, staticResults, sandbox }) {
  const signals = (sandbox && sandbox.signals) || {};
  const contradicted = (staticResults || []).some(
    (s) => s.result && s.result.status === 'absent'
  );
  const needsUnrealisticConditions = signals.precondition_met === false;
  const securityRelevant = !!(observed && (observed.boundaryCrossed || observed.secretRead));
  let rationale;
  if (contradicted) rationale = 'Static analysis shows a named file or function does not exist.';
  else if (needsUnrealisticConditions)
    rationale = 'Reproduction requires conditions the sandbox could not satisfy.';
  else if (securityRelevant) rationale = 'Sandbox observed a real boundary crossing.';
  else rationale = 'PoC ran without demonstrating security-relevant impact.';
  return { securityRelevant, needsUnrealisticConditions, contradicted, rationale };
}

async function adversarialJudge({ report, observed, claims, staticResults, sandbox }) {
  if (llm.available()) {
    try {
      const content = await llm.chat(
        [
          { role: 'system', content: ADVERSARIAL_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              report: { title: report.title, body: report.body },
              observed,
              staticResults: (staticResults || []).map((s) => ({
                claim: s.claim ? s.claim.text : s.text,
                status: s.result ? s.result.status : undefined,
              })),
              signals: sandbox ? sandbox.signals : {},
            }),
          },
        ],
        { temperature: 0, jsonMode: true }
      );
      const parsed = llm.parseJson(content);
      if (parsed && typeof parsed.securityRelevant === 'boolean') {
        console.error('[agent] adversarial pass via Vultr inference');
        return {
          securityRelevant: !!parsed.securityRelevant,
          needsUnrealisticConditions: !!parsed.needsUnrealisticConditions,
          contradicted: !!parsed.contradicted,
          rationale: String(parsed.rationale || '').slice(0, 300),
        };
      }
      throw new Error('bad JSON');
    } catch (err) {
      console.error(`[agent] LLM adversarial failed (${err.code || err.message}); using heuristic`);
    }
  } else {
    console.error('[agent] no inference key; adversarial pass via heuristic');
  }
  return adversarialHeuristic({ observed, staticResults, sandbox });
}

module.exports = { extractClaims, staticCheck, adversarialJudge };
