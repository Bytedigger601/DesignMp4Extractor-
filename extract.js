#!/usr/bin/env node
// Extracts a Claude Design <Stage> animation HTML file to MP4.
//
// Usage:
//   node extract.js <input.html> [-o out.mp4] [--fps 60] [--crf 18] [--scale 1]
//                                [--start 0] [--end <duration>] [--format jpeg|png]

const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

// ── CDN cache ────────────────────────────────────────────────────────────────
// Intercept unpkg/jsdelivr requests and serve from a local disk cache so
// renders never depend on CDN availability or speed.
const CDN_CACHE_DIR = path.join(__dirname, '.cdn-cache');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'design-mp4-extractor' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function cachedFetch(url) {
  fs.mkdirSync(CDN_CACHE_DIR, { recursive: true });
  const key = url.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
  const file = path.join(CDN_CACHE_DIR, key);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const buf = await fetchUrl(url);
  fs.writeFileSync(file, buf);
  return buf;
}

// Pre-warm the CDN cache by scanning the HTML for external script src URLs
// and downloading any that aren't cached yet — before the browser starts,
// so the Playwright route handler never has to do a slow network fetch.
async function prewarmCdnCache(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const CDN_RE = /https?:\/\/(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)[^\s"'>]+/g;
  const urls = [...new Set(html.match(CDN_RE) || [])];
  for (const url of urls) {
    fs.mkdirSync(CDN_CACHE_DIR, { recursive: true });
    const key = url.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const file = path.join(CDN_CACHE_DIR, key);
    if (!fs.existsSync(file)) {
      try {
        process.stderr.write(`  Caching ${url} …\n`);
        const buf = await fetchUrl(url);
        fs.writeFileSync(file, buf);
      } catch (e) {
        process.stderr.write(`  Warning: could not cache ${url}: ${e.message}\n`);
      }
    }
  }
}

function installCdnInterceptor(page) {
  page.route(/unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/, async (route) => {
    const url = route.request().url();
    try {
      const body = await cachedFetch(url);
      const ct = url.endsWith('.css') ? 'text/css' : 'application/javascript';
      await route.fulfill({ status: 200, contentType: ct, body });
    } catch (e) {
      // Cache miss + network fail → let it through so the page can try
      await route.continue();
    }
  });
}

// Resolve ffmpeg: env override > ffmpeg-static (bundled) > "ffmpeg" on PATH.
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {}
  return 'ffmpeg';
}
const FFMPEG = resolveFfmpeg();

function parseArgs(argv) {
  const a = {
    input: null, output: null, fps: null, crf: 18, scale: 1,
    start: 0, end: null, format: 'jpeg', jpegQuality: 95,
    headed: false, preset: 'veryfast', json: false,
    captions: true, captionHz: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-o' || k === '--output') a.output = argv[++i];
    else if (k === '--fps') a.fps = parseInt(argv[++i], 10);
    else if (k === '--crf') a.crf = parseInt(argv[++i], 10);
    else if (k === '--scale') a.scale = parseFloat(argv[++i]);
    else if (k === '--start') a.start = parseFloat(argv[++i]);
    else if (k === '--end') a.end = parseFloat(argv[++i]);
    else if (k === '--format') a.format = argv[++i];
    else if (k === '--jpeg-quality') a.jpegQuality = parseInt(argv[++i], 10);
    else if (k === '--preset') a.preset = argv[++i];
    else if (k === '--headed') a.headed = true;
    else if (k === '--json') a.json = true;
    else if (k === '--no-captions') a.captions = false;
    else if (k === '--caption-hz') a.captionHz = parseFloat(argv[++i]);
    else if (k === '-h' || k === '--help') { printHelp(); process.exit(0); }
    else if (!a.input) a.input = k;
    else { console.error('Unknown arg:', k); process.exit(2); }
  }
  return a;
}

let JSON_MODE = false;
function emit(event) {
  if (JSON_MODE) process.stdout.write(JSON.stringify(event) + '\n');
}
function info(...args) {
  if (!JSON_MODE) console.log(...args);
}

function printHelp() {
  console.log(`Claude Design → MP4 extractor

  node extract.js <input.html> [options]

Options:
  -o, --output <path>     Output MP4 path (default: <input>.mp4)
      --fps <n>           Render frame rate (default: from Stage)
      --crf <n>           x264 quality (lower=better, default 18)
      --scale <n>         Output scale multiplier (e.g. 0.5 for half-res)
      --start <sec>       Start time in source seconds (default 0)
      --end <sec>         End time in source seconds (default Stage duration)
      --format <fmt>      jpeg (fast, default) or png (lossless intermediate)
      --jpeg-quality <n>  JPEG q (default 95, only for jpeg format)
      --preset <p>        x264 preset (default veryfast; medium/slow for smaller files)
      --no-captions       Skip writing the .srt sidecar
      --caption-hz <n>    Caption sample rate in Hz (default 10)
      --headed            Show the browser window (debug)
  -h, --help              Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  JSON_MODE = args.json;
  if (!args.input) { printHelp(); process.exit(2); }

  const inputHtml = path.resolve(args.input);
  if (!fs.existsSync(inputHtml)) {
    emit({ type: 'error', message: `Input not found: ${inputHtml}` });
    if (!JSON_MODE) console.error(`Input not found: ${inputHtml}`);
    process.exit(1);
  }

  const outputMp4 = path.resolve(
    args.output || inputHtml.replace(/\.[^.]+$/, '') + '.mp4'
  );

  info('▶ Extracting:', inputHtml);
  info('▶ Output:    ', outputMp4);
  emit({ type: 'start', input: inputHtml, output: outputMp4 });

  const initScript = fs.readFileSync(path.join(__dirname, 'page-init.js'), 'utf8');

  // Download any CDN scripts the HTML needs before the browser starts,
  // so the route handler never blocks on a slow network fetch.
  info('▶ Checking CDN cache…');
  emit({ type: 'phase', phase: 'cdn-cache' });
  await prewarmCdnCache(inputHtml);

  const browser = await chromium.launch({
    headless: !args.headed,
    args: [
      '--disable-web-security',
      '--allow-file-access-from-files',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });

  let ffmpegProc = null;
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      bypassCSP: true,
    });
    await context.addInitScript(initScript);

    const page = await context.newPage();
    // Raise the default so Playwright's context-level cap doesn't override
    // the explicit timeouts we pass to waitForFunction/goto below.
    page.setDefaultTimeout(90000);
    // Serve CDN scripts from local disk cache — eliminates unpkg flakiness.
    installCdnInterceptor(page);
    page.on('pageerror', (err) => console.error('[page]', err.message));
    page.on('console', (msg) => {
      const t = msg.type();
      if ((t === 'error' || t === 'warning') && !JSON_MODE) {
        console.log(`[console.${t}]`, msg.text());
      }
    });

    const fileUrl = 'file:///' + inputHtml.replace(/\\/g, '/').replace(/^\/+/, '');

    info('▶ Loading page...');
    emit({ type: 'phase', phase: 'mount' });

    // Detect missing local files (incomplete zip export) early so we fail fast
    // instead of waiting 90s for a Stage that will never mount.
    const missingFiles = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (t.includes('ERR_FILE_NOT_FOUND') || t.includes('net::ERR_FILE_NOT_FOUND')) {
          // Extract the filename from the URL in the error
          const m = t.match(/file:\/\/[^\s)]+/);
          if (m) missingFiles.push(path.basename(decodeURIComponent(m[0])));
        }
      }
    });

    // Boot can fail if unpkg.com is slow loading React/Babel. Retry once with a fresh navigation.
    const bootOnce = async (timeoutMs) => {
      await page.goto(fileUrl, { waitUntil: 'load', timeout: 60000 });
      // Give the page 3s to surface file-not-found errors before waiting for Stage
      await page.waitForTimeout(3000);
      if (missingFiles.length > 0) {
        throw new Error(
          `Missing files in the zip: ${[...new Set(missingFiles)].join(', ')}\n` +
          `Re-export from Claude Design and make sure the zip contains ALL .jsx files, not just the HTML.`
        );
      }
      await page.waitForFunction(() => window.__stageProps != null, { timeout: timeoutMs });
    };
    try {
      await bootOnce(45000);
    } catch (err) {
      if (!/Timeout/i.test(err.message)) throw err;
      info('▶ Boot timed out — retrying once (CDN may be slow)...');
      emit({ type: 'phase', phase: 'mount-retry' });
      await bootOnce(60000);
    }

    const stage = await page.evaluate(() => window.__stageProps);
    info('▶ Stage props:', stage);
    emit({ type: 'stage', ...stage });

    const width = stage.width;
    const height = stage.height;
    const duration = stage.duration;
    const stageFps = stage.fps || 60;
    const fps = args.fps || stageFps;

    const startSec = Math.max(0, args.start);
    const endSec = args.end != null ? Math.min(args.end, duration) : duration;
    if (endSec <= startSec) throw new Error('end must be > start');

    await page.setViewportSize({ width, height: height + 50 });

    await page.evaluate(async () => {
      try { await document.fonts.ready; } catch {}
    });
    await page.waitForTimeout(300);

    const canvasHandle = await page.evaluateHandle(() => {
      const candidates = Array.from(document.querySelectorAll('#root div'));
      return (
        candidates.find(
          (el) =>
            el.style.transform &&
            el.style.transform.includes('scale') &&
            el.style.position === 'relative'
        ) || null
      );
    });
    const canvasEl = canvasHandle.asElement();
    if (!canvasEl) throw new Error('Could not locate Stage canvas element.');

    const box = await canvasEl.boundingBox();
    if (!box) throw new Error('Canvas has no bounding box.');

    // Use a fixed clip rect — much faster than element.screenshot() because
    // Playwright skips bounding-box recomputation per call.
    const clip = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };

    if (Math.abs(clip.width - width) > 2 || Math.abs(clip.height - height) > 2) {
      console.warn(`! canvas rendered at ${clip.width}x${clip.height}, expected ${width}x${height}.`);
    }

    // Prime the timer.
    await page.evaluate(() => window.__animExtractor.advanceMs(0));
    if (startSec > 0) {
      await page.evaluate((ms) => window.__animExtractor.advanceMs(ms), startSec * 1000);
    }
    await page.waitForTimeout(50);

    const stepMs = 1000 / fps;
    const totalFrames = Math.round((endSec - startSec) * fps);
    info(`▶ Rendering ${totalFrames} frames at ${fps}fps (${(totalFrames / fps).toFixed(2)}s) — format: ${args.format}`);
    emit({ type: 'render-start', totalFrames, fps, durationSec: totalFrames / fps, format: args.format });

    // Pipe screenshots straight into ffmpeg's stdin (no disk I/O).
    const outW = Math.round(width * args.scale);
    const outH = Math.round(height * args.scale);
    const evenW = outW % 2 === 0 ? outW : outW - 1;
    const evenH = outH % 2 === 0 ? outH : outH - 1;

    const ffArgs = [
      '-y',
      '-loglevel', 'error',
      '-stats',
      '-f', 'image2pipe',
      '-framerate', String(fps),
      '-c:v', args.format === 'png' ? 'png' : 'mjpeg',
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', String(args.crf),
      '-preset', args.preset,
      '-vf', `scale=${evenW}:${evenH}:flags=lanczos`,
      '-movflags', '+faststart',
      outputMp4,
    ];

    ffmpegProc = spawn(FFMPEG, ffArgs, {
      stdio: ['pipe', 'inherit', JSON_MODE ? 'pipe' : 'inherit'],
    });
    if (JSON_MODE && ffmpegProc.stderr) ffmpegProc.stderr.on('data', () => {}); // silence
    ffmpegProc.on('error', (err) => { throw new Error('ffmpeg launch: ' + err.message); });

    const screenshotOpts = args.format === 'png'
      ? { type: 'png', clip, omitBackground: false }
      : { type: 'jpeg', quality: args.jpegQuality, clip, omitBackground: false };

    // Caption capture: sample the largest visible text inside the canvas.
    const captionSamples = []; // {tSec, text}
    const captionEveryFrames = args.captions
      ? Math.max(1, Math.round(fps / Math.max(1, args.captionHz)))
      : Infinity;
    let lastCaption = null;
    const sampleCaption = async () => {
      try {
        return await canvasEl.evaluate((root) => {
          let bestText = null, bestSize = 0;
          const walk = (el) => {
            for (const child of el.children) walk(child);
            const own = Array.from(el.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent)
              .join('')
              .trim();
            if (!own || own.length < 2) return;
            const cs = getComputedStyle(el);
            if (parseFloat(cs.opacity) < 0.4) return;
            if (cs.visibility === 'hidden' || cs.display === 'none') return;
            const size = parseFloat(cs.fontSize) || 0;
            if (size > bestSize) { bestSize = size; bestText = own; }
          };
          walk(root);
          if (!bestText) return null;
          const skip = new Set(['REC', '●']);
          if (skip.has(bestText)) return null;
          return bestText;
        });
      } catch { return null; }
    };

    const t0 = Date.now();
    for (let i = 0; i < totalFrames; i++) {
      const buf = await page.screenshot(screenshotOpts);

      if (!ffmpegProc.stdin.write(buf)) {
        await new Promise((r) => ffmpegProc.stdin.once('drain', r));
      }

      if (args.captions && i % captionEveryFrames === 0) {
        const tSec = startSec + i / fps;
        const cap = await sampleCaption();
        if (cap && cap !== lastCaption) {
          captionSamples.push({ tSec, text: cap });
          lastCaption = cap;
          emit({ type: 'caption', t: tSec, text: cap });
        } else if (cap) {
          captionSamples.push({ tSec, text: cap });
        }
      }

      await page.evaluate((ms) => window.__animExtractor.advanceMs(ms), stepMs);

      const isReportTick = i % 10 === 0 || i === totalFrames - 1;
      if (isReportTick) {
        const pct = ((i + 1) / totalFrames) * 100;
        const elapsed = (Date.now() - t0) / 1000;
        const fpsActual = (i + 1) / elapsed;
        const eta = (totalFrames - i - 1) / Math.max(0.1, fpsActual);
        emit({ type: 'frame', i: i + 1, total: totalFrames, pct, fpsActual, etaSec: eta });
        if (!JSON_MODE) {
          process.stdout.write(
            `\r  frame ${i + 1}/${totalFrames}  ${pct.toFixed(0)}%  ${fpsActual.toFixed(1)} fps  ~${eta.toFixed(0)}s left   `
          );
        }
      }
    }
    if (!JSON_MODE) process.stdout.write('\n');
    emit({ type: 'phase', phase: 'encoding' });

    ffmpegProc.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpegProc.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
    });

    const stat = fs.statSync(outputMp4);
    info(`✓ Done: ${outputMp4} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    let srtPath = null;
    if (args.captions && captionSamples.length > 0) {
      srtPath = outputMp4.replace(/\.mp4$/i, '') + '.srt';
      const srt = buildSRT(captionSamples, endSec - startSec);
      fs.writeFileSync(srtPath, srt, 'utf8');
      info(`✓ Captions: ${srtPath} (${srt.split('\n\n').filter(Boolean).length} entries)`);
    }

    emit({ type: 'done', output: outputMp4, sizeBytes: stat.size, srt: srtPath });
  } finally {
    if (ffmpegProc && !ffmpegProc.killed && ffmpegProc.exitCode == null) {
      try { ffmpegProc.stdin.end(); } catch {}
    }
    await browser.close();
  }
}

function buildSRT(samples, totalDur) {
  if (!samples.length) return '';
  // Group consecutive samples with the same text into one cue.
  const groups = [];
  let cur = { tStart: samples[0].tSec, tEnd: samples[0].tSec, text: samples[0].text };
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].text === cur.text) {
      cur.tEnd = samples[i].tSec;
    } else {
      groups.push(cur);
      cur = { tStart: samples[i].tSec, tEnd: samples[i].tSec, text: samples[i].text };
    }
  }
  groups.push(cur);
  // Stretch each cue to the next cue's start (or +0.5s for the last).
  for (let i = 0; i < groups.length; i++) {
    const next = groups[i + 1];
    groups[i].tEnd = next ? next.tStart : Math.min(totalDur, groups[i].tEnd + 0.5);
    if (groups[i].tEnd <= groups[i].tStart) groups[i].tEnd = groups[i].tStart + 0.1;
  }
  const fmt = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = ms % 1000;
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(cs, 3)}`;
  };
  return groups
    .map((g, i) => `${i + 1}\n${fmt(g.tStart)} --> ${fmt(g.tEnd)}\n${g.text}\n`)
    .join('\n');
}

main().catch((err) => {
  emit({ type: 'error', message: err.message });
  if (!JSON_MODE) console.error('✗ Failed:', err.message);
  process.exit(1);
});
