# demo-app

A tiny note-serving HTTP service used as ProofGate's test target. It is
intentionally vulnerable so the pipeline has something real to verify.

Routes:
- `GET /health` returns `ok`
- `GET /note?name=<file>` returns the contents of `<file>` from `notes/`

Run: `node server.js` then open `http://localhost:3000/note?name=welcome.txt`

This project contains a planted, inert path-traversal bug for
demonstration only. Do not deploy it.
