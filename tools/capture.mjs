// Captures the README images with a headless Chromium over the DevTools
// protocol. Start the server first (node tools/serve.mjs), then:
//
//   node tools/capture.mjs [browser.exe]
//
// It loads a fresh sheet, runs a voltage sweep so Fig. 2 has readings, and
// writes media/drift-sheet.png and media/drift-fig2.png.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const URL_ = 'http://localhost:5180/';
const PORT = 9333;
const browser =
  process.argv[2] ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('browser did not come up');
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
}

async function shoot(send, file, clip) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) });
  writeFileSync(join(root, 'media', file), Buffer.from(data, 'base64'));
  console.log('wrote', file);
}

const profile = mkdtempSync(join(tmpdir(), 'drift-capture-'));
const proc = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  '--window-size=1440,900',
  'about:blank',
]);

try {
  const ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener('open', r));
  const send = client(ws);
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

  // Desktop sheet.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(4000);
  await evaluate("document.getElementById('sweep').click()");
  for (let t = 0; t < 180; t++) {
    await sleep(1000);
    const label = await evaluate("document.getElementById('sweep').textContent");
    if (label === 'Sweep') break;
  }
  await evaluate("(() => { const v = document.getElementById('volts'); v.value = 9; v.dispatchEvent(new Event('input')); })()");
  await sleep(9000);
  await evaluate('window.scrollTo(0, 0)');
  await sleep(500);
  await shoot(send, 'drift-sheet.png', { x: 0, y: 0, width: 1440, height: 900, scale: 1 });
  const box = await evaluate(
    "(() => { const r = document.querySelector('.fig2').getBoundingClientRect(); return { x: r.left - 40, y: r.top + scrollY - 40, width: r.width + 80, height: r.height + 60 }; })()",
  );
  await shoot(send, 'drift-fig2.png', { ...box, scale: 1 });

  ws.close();
} finally {
  proc.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold the profile for a moment */
  }
}
