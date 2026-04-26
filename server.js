#!/usr/bin/env node
// Minimal local web UI for the Claude Design MP4 extractor.
//   node server.js [--port 5173]
// Visit http://localhost:5173

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { URL } = require('url');
const readline = require('readline');
const AdmZip = require('adm-zip');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(os.tmpdir(), 'design-mp4-uploads');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  if (i > -1) return parseInt(process.argv[i + 1], 10) || 5173;
  return 5173;
})();

// Single in-flight job. UI is single-user so this is fine.
let job = null; // { id, proc, events: [], listeners: Set, status, output }

function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function findHtml(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = findHtml(f);
      if (sub) return sub;
    } else if (/\.html?$/i.test(entry.name)) {
      return f;
    }
  }
  return null;
}

function pushEvent(j, ev) {
  j.events.push(ev);
  for (const res of j.listeners) {
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
  }
}

function startJob(opts) {
  if (job && job.status === 'running') {
    throw new Error('A job is already running. Cancel it first.');
  }
  const id = newJobId();
  const args = ['extract.js', '--json', opts.input];
  if (opts.output) args.push('-o', opts.output);
  if (opts.fps) args.push('--fps', String(opts.fps));
  if (opts.crf != null) args.push('--crf', String(opts.crf));
  if (opts.scale) args.push('--scale', String(opts.scale));
  if (opts.start) args.push('--start', String(opts.start));
  if (opts.end) args.push('--end', String(opts.end));
  if (opts.format) args.push('--format', opts.format);
  if (!opts.captions) args.push('--no-captions');

  const proc = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  job = {
    id, proc,
    events: [],
    listeners: new Set(),
    status: 'running',
    output: null,
    args: opts,
    startedAt: Date.now(),
  };

  pushEvent(job, { type: 'job-started', id, args: opts });

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line.startsWith('{')) return;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'done') {
        job.output = ev.output;
        job.status = 'done';
      } else if (ev.type === 'error') {
        job.status = 'error';
      }
      pushEvent(job, ev);
    } catch {}
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
  });

  proc.on('close', (code) => {
    if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error';
      if (code !== 0) pushEvent(job, { type: 'error', message: `exit ${code}: ${stderrBuf.trim()}` });
    }
    pushEvent(job, { type: 'job-closed', code });
    for (const res of job.listeners) { try { res.end(); } catch {} }
    job.listeners.clear();
  });

  proc.on('error', (err) => {
    job.status = 'error';
    pushEvent(job, { type: 'error', message: err.message });
  });

  return id;
}

function cancelJob() {
  if (job && job.status === 'running') {
    try { job.proc.kill('SIGTERM'); } catch {}
    job.status = 'cancelled';
    pushEvent(job, { type: 'cancelled' });
    return true;
  }
  return false;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendFile(res, filePath, mime) {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.mp4':  'video/mp4',
};

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // Static
    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(204); res.end(); return; // no favicon, no 404 noise
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), MIME['.html']);
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const file = path.join(PUBLIC_DIR, p.slice('/static/'.length));
      if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      return sendFile(res, file, MIME[ext] || 'application/octet-stream');
    }

    // API
    if (req.method === 'POST' && p === '/api/extract') {
      const body = JSON.parse(await readBody(req));
      if (!body.input) return send(res, 400, { error: 'input required' });
      if (!fs.existsSync(body.input)) return send(res, 400, { error: 'input file not found: ' + body.input });
      const id = startJob(body);
      return send(res, 200, { id });
    }

    if (req.method === 'POST' && p === '/api/cancel') {
      const ok = cancelJob();
      return send(res, 200, { cancelled: ok });
    }

    if (req.method === 'GET' && p === '/api/status') {
      if (!job) return send(res, 200, { status: 'idle' });
      return send(res, 200, {
        id: job.id,
        status: job.status,
        output: job.output,
        args: job.args,
        startedAt: job.startedAt,
        eventCount: job.events.length,
      });
    }

    if (req.method === 'GET' && p === '/api/events') {
      if (!job) return send(res, 404, { error: 'no job' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Replay backlog so the client sees what already happened.
      for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (job.status !== 'running') {
        res.end();
        return;
      }
      job.listeners.add(res);
      req.on('close', () => job.listeners.delete(res));
      return;
    }

    if (req.method === 'GET' && p === '/api/file') {
      const fp = url.searchParams.get('path');
      if (!fp || !fs.existsSync(fp)) return send(res, 404, { error: 'not found' });
      const ext = path.extname(fp).toLowerCase();
      return sendFile(res, fp, MIME[ext] || 'application/octet-stream');
    }

    if (req.method === 'POST' && p === '/api/reveal') {
      const body = JSON.parse(await readBody(req));
      if (!body.path || !fs.existsSync(body.path)) return send(res, 404, { error: 'not found' });
      const cmd = process.platform === 'win32' ? 'explorer'
                : process.platform === 'darwin' ? 'open'
                : 'xdg-open';
      const args = process.platform === 'win32' ? ['/select,', body.path] : ['-R', body.path];
      execFile(cmd, args, () => {});
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/open') {
      const body = JSON.parse(await readBody(req));
      if (!body.path || !fs.existsSync(body.path)) return send(res, 404, { error: 'not found' });
      const cmd = process.platform === 'win32' ? 'cmd'
                : process.platform === 'darwin' ? 'open'
                : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', body.path] : [body.path];
      execFile(cmd, args, () => {});
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/upload') {
      const name = url.searchParams.get('name') || 'upload.zip';
      if (!/\.zip$/i.test(name)) return send(res, 400, { error: 'expected .zip file' });
      const id = newJobId();
      const dest = path.join(UPLOAD_DIR, id);
      fs.mkdirSync(dest, { recursive: true });
      const zipPath = path.join(dest, name);
      const ws = fs.createWriteStream(zipPath);
      await new Promise((resolve, reject) => {
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      const extractDir = path.join(dest, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        new AdmZip(zipPath).extractAllTo(extractDir, true);
      } catch (e) {
        return send(res, 400, { error: 'Could not unzip: ' + e.message });
      }
      const htmlFile = findHtml(extractDir);
      if (!htmlFile) return send(res, 400, { error: 'no .html file inside zip' });
      return send(res, 200, { path: htmlFile, dir: extractDir, id });
    }

    if (req.method === 'POST' && p === '/api/check') {
      const body = JSON.parse(await readBody(req));
      const exists = body.path && fs.existsSync(body.path);
      return send(res, 200, { exists, isFile: exists && fs.statSync(body.path).isFile() });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

// Ensure Playwright's Chromium is installed before the first job runs.
// This happens lazily on server start rather than as a postinstall step,
// so `npx` and fresh installs don't time out during npm install.
function ensureChromium() {
  return new Promise((resolve) => {
    const pw = spawn(process.execPath, ['node_modules/.bin/playwright', 'install', 'chromium'], {
      cwd: ROOT, stdio: 'inherit',
      // On Windows the .bin shim is a .cmd file
      shell: process.platform === 'win32',
    });
    pw.on('close', (code) => {
      if (code !== 0) console.warn('⚠ playwright install chromium exited', code, '— continuing anyway');
      resolve();
    });
    pw.on('error', () => resolve()); // already installed / not found → continue
  });
}

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`▶ Design MP4 Extractor UI: ${url}`);
  // Auto-open browser immediately — server is already accepting connections.
  const cmd = process.platform === 'win32' ? 'cmd'
            : process.platform === 'darwin' ? 'open'
            : 'xdg-open';
  const openArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, openArgs, () => {});

  // Install Chromium in the background (fast no-op if already installed).
  console.log('▶ Checking Playwright Chromium…');
  await ensureChromium();
  console.log('▶ Ready.');
});
