// pipeline/verdict.js
// Combines concrete sandbox signals (which lead) with the adversarial
// judgement (which refines) into exactly one of four verdict states, plus
// a per-claim breakdown. Concrete evidence always outranks opinion.

function decideVerdict({ report, claims, staticResults, sandbox, adversarial }) {
  const observed = (sandbox && sandbox.observed) || {};
  const signals = (sandbox && sandbox.signals) || {};

  const contradicted = adversarial && adversarial.contradicted;
  const preconditionUnmet =
    signals.precondition_met === false || adversarial.needsUnrealisticConditions;
  const serverFailed = report.poc && report.poc.needsServer && observed.serverUp === false;
  const buildBroke = signals.build === 'copy_failed';
  const impact = observed.boundaryCrossed === true || observed.secretRead === true;
  const securityRelevant = adversarial && adversarial.securityRelevant;

  let verdict;
  let summary;

  if (contradicted) {
    verdict = 'CONTRADICTED';
    summary =
      'The report’s core factual basis is false: a named file or function does not exist at the stated commit.';
  } else if (impact && securityRelevant) {
    verdict = 'REPRODUCED';
    summary =
      'The sandbox independently demonstrated the claimed security impact. Evidence package is re-runnable.';
  } else if (preconditionUnmet || serverFailed || buildBroke || sandbox.timedOut) {
    verdict = 'INCONCLUSIVE';
    if (preconditionUnmet)
      summary =
        'Reproduction depends on conditions the sandbox could not satisfy; neither confirmed nor refuted.';
    else if (serverFailed) summary = 'Target service failed to start; result is inconclusive.';
    else if (buildBroke) summary = 'Project could not be built in the sandbox; result is inconclusive.';
    else summary = 'Run hit the hard timeout; result is inconclusive.';
  } else {
    verdict = 'NOT_REPRODUCED';
    summary =
      'The PoC ran but showed no security-relevant impact. Not auto-closing — recommend one manual review before dismissal.';
  }

  // Per-claim verdicts.
  const perClaim = (claims || []).map((claim, i) => {
    const sres = staticResults && staticResults[i] ? staticResults[i].result : null;
    if (sres && sres.status === 'absent') {
      return { text: claim.text, verdict: 'CONTRADICTED', reason: sres.detail };
    }
    if (sres && sres.status === 'present') {
      return { text: claim.text, verdict: 'CONFIRMED', reason: sres.detail };
    }
    if (claim.type === 'version' && preconditionUnmet) {
      return {
        text: claim.text,
        verdict: 'INCONCLUSIVE',
        reason: 'version-gated condition not reproducible in sandbox',
      };
    }
    if (claim.type === 'behavior') {
      if (verdict === 'REPRODUCED')
        return { text: claim.text, verdict: 'REPRODUCED', reason: 'demonstrated in sandbox' };
      if (verdict === 'CONTRADICTED')
        return { text: claim.text, verdict: 'CONTRADICTED', reason: 'depends on a false premise' };
      if (verdict === 'INCONCLUSIVE')
        return { text: claim.text, verdict: 'INCONCLUSIVE', reason: summary };
      return { text: claim.text, verdict: 'NOT_REPRODUCED', reason: 'no impact observed' };
    }
    return { text: claim.text, verdict: 'UNKNOWN', reason: sres ? sres.detail : 'not decided' };
  });

  return { verdict, perClaim, summary };
}

module.exports = { decideVerdict };
