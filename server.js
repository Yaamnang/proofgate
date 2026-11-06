// server.js
// One service: serves the static dashboard AND runs the verification
// orchestrator, streaming live progress to the browser over SSE.

const express = require('express');
const fs = require('fs');
const path = require('path');

const pipeline = require('./pipeline');
const runner = require('./sandbox/runner');
const llm = require('./agent/llm');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const REPORTS_DIR = path.join(__dirname, 'fixtures', 'reports');
const EVIDENCE_ROOT = path.join(__dirname, 'evidence');
const PUBLIC_DIR = path.join(__dirname, 'public');

function loadReports() {
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function loadReport(id) {
  const file = path.join(REPORTS_DIR, `report-${String(id).toLowerCase()}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

app.use(express.static(PUBLIC_DIR));

app.get('/api/config', (req, res) => {
  res.json({
    model: llm.MODEL,
    runtime: runner.RUNTIME === 'runsc' ? 'gVisor (runsc)' : 'runc + hardening flags',
    inferenceConfigured: llm.available(),
  });
});

app.get('/api/reports', (req, res) => {
  res.json(
    loadReports().map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      hostile: !!r.hostile,
    }))
  );
});

app.get('/api/verify/:id', async (req, res) => {
  const report = loadReport(req.params.id);
  if (!report) {
    res.status(404).json({ error: 'unknown report' });
    return;
  }

  // SSE headers. Disable proxy buffering and compression for live flush.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const emit = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await pipeline.verify(report, emit);
  } catch (err) {
    // pipeline already emitted 'error'
  } finally {
    if (!closed) res.end();
  }
});

app.get('/api/evidence/:evidenceId.zip', (req, res) => {
  const id = req.params.evidenceId.replace(/[^A-Za-z0-9\-_.]/g, '');
  const zipPath = path.join(EVIDENCE_ROOT, id + '.zip');
  if (!zipPath.startsWith(EVIDENCE_ROOT) || !fs.existsSync(zipPath)) {
    res.status(404).send('evidence not found');
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="proofgate-evidence-${id}.zip"`);
  fs.createReadStream(zipPath).pipe(res);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ProofGate listening on http://0.0.0.0:${PORT}`);
  console.log(`  runtime: ${runner.RUNTIME}   inference: ${llm.available() ? 'configured' : 'not set (heuristic fallback)'}`);
});
