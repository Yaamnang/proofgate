// demo-app: a deliberately vulnerable mini document service.
// It exposes notes stored under ./notes over HTTP.
//
// PLANTED BUG (inert, self-contained, for ProofGate's demo only):
// getNote() builds a file path by concatenating the user-supplied
// `name` onto the notes directory WITHOUT sanitising "..". A request
// such as  /note?name=../secret.txt  escapes the notes directory and
// reads an arbitrary file inside the container. This is a classic
// path traversal (CWE-22). Nothing here is weaponised: it only reads
// files inside its own throwaway container.

const http = require('http');
const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, 'notes');
const PORT = process.env.PORT || 3000;

function getNote(name) {
  // VULNERABLE: no normalisation / containment check.
  const target = NOTES_DIR + '/' + name;
  return fs.readFileSync(target, 'utf8');
}

// A safe version is kept for reference so maintainers can see the fix.
// eslint-disable-next-line no-unused-vars
function getNoteSafe(name) {
  const resolved = path.resolve(NOTES_DIR, name);
  if (!resolved.startsWith(NOTES_DIR + path.sep)) {
    throw new Error('path escapes notes directory');
  }
  return fs.readFileSync(resolved, 'utf8');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/note') {
    const name = url.searchParams.get('name') || '';
    try {
      const body = getNote(name);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(body);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found: ' + err.message);
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('unknown route');
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`demo-app listening on ${PORT}`);
  });
}

module.exports = { getNote, getNoteSafe, server };
