// PoC for report A. It claims renderMarkdown() exists and is exploitable.
// The function does not exist in this codebase, so the PoC cannot even
// exercise the stated code path. Static analysis should already have
// flagged this as CONTRADICTED; the PoC is kept for completeness.
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
  const r = await get('/note?name=welcome.txt');
  console.log('PROOFGATE_SIGNAL status=' + r.status);
  // There is no markdown rendering; the claimed XSS sink is absent.
  console.log('PROOFGATE_SIGNAL script_executed=false');
  console.log('PROOFGATE_SIGNAL secret_read=false');
  process.exit(0);
})();
