// PoC for report C. The claimed crash depends on a runtime condition the
// sandbox cannot satisfy: Node < 18 plus a production-only env flag. The
// sandbox runs a current Node, so the PoC cannot confirm OR refute the
// claim on the stated conditions. Correct outcome: INCONCLUSIVE.
const http = require('http');

function get(pathname) {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:3000' + pathname, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', (e) => resolve({ status: 0, body: String(e) }));
  });
}

(async () => {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  const legacyFlag = process.env.DEMO_LEGACY_BUFFER === '1';
  console.log('PROOFGATE_SIGNAL node_major=' + major);
  console.log('PROOFGATE_SIGNAL legacy_flag=' + legacyFlag);

  if (major >= 18 || !legacyFlag) {
    // Required conditions not met in this environment.
    console.log('PROOFGATE_SIGNAL precondition_met=false');
    console.log('PROOFGATE_SIGNAL crash=false');
    console.log('PROOFGATE_SIGNAL reason=stated_conditions_unavailable');
    process.exit(0);
  }

  const r = await get('/note?name=welcome.txt');
  console.log('PROOFGATE_SIGNAL status=' + r.status);
  console.log('PROOFGATE_SIGNAL crash=false');
  process.exit(0);
})();
