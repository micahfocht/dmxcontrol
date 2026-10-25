import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultState, migrateState, validatePatch, validateChannels, validateLevels, percent, name } from './fixtures.js';
import { Adapters, validateAdapters } from './adapters.js';
import { Controller } from './controller.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DMX_DATA_DIR || path.join(root, 'data');
const statePath = path.join(dataDir, 'state.json');
await mkdir(dataDir, { recursive: true });
let state;
try {
  state = migrateState(JSON.parse(await readFile(statePath, 'utf8')));
  if (state.version !== 2 || !/^[0-9a-f-]{36}$/i.test(state.cid)) throw new Error('Unsupported state file.');
  state.adapters = validateAdapters(state.adapters);
  state.fixtures = validatePatch(state.fixtures, state.adapters);
  percent(state.master);
  if (typeof state.blackout !== 'boolean' || !Array.isArray(state.profiles) || state.profiles.length > 64 || !Array.isArray(state.scenes) || state.scenes.length > 32) throw new Error('Invalid saved state.');
  for (const p of state.profiles) { name(p.name); p.channels = validateChannels(p.channels); }
  for (const s of state.scenes) { name(s.name); percent(s.fade); percent(s.master); for (const levels of Object.values(s.fixtures)) validateLevels(levels); }
} catch (e) {
  if (e.code !== 'ENOENT') throw new Error(`Could not load ${statePath}: ${e.message}. Restore the file from a backup or move it aside to start fresh.`);
  state = defaultState();
}
// Output connections are never restored automatically after a restart.
state.activeScene = null;
let dirty = true, persistTimer, persistenceError = null, writeQueue = Promise.resolve();
const output = new Adapters(state, () => { dirty = true; }, () => controller.changed(), () => !!controller.fade);
const controller = new Controller(state, output, () => {
  dirty = true;
  if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 1000);
});
function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    await writeFile(`${statePath}.tmp`, snapshot, { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
    persistenceError = null;
  }).catch(e => { persistenceError = `Changes could not be saved: ${e.message}`; dirty = true; console.error(persistenceError); });
  return writeQueue;
}
const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/app.js', ['public/app.js', 'text/javascript']],
  ['/styles.css', ['public/styles.css', 'text/css']],
  ['/icon.svg', ['assets/icon.svg', 'image/svg+xml']],
]);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'");
  try {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, output: output.status, persistenceError })); return;
    }
    if (url.pathname === '/api/interfaces') {
      const interfaces = Object.entries(networkInterfaces()).flatMap(([name, list]) => list.filter(i => i.family === 'IPv4' && !i.internal).map(i => ({ name, address: i.address })));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(interfaces)); return;
    }
    const file = staticFiles.get(url.pathname);
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    const content = await readFile(path.join(root, file[0]));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(content);
  } catch (e) { console.error(e); res.writeHead(500); res.end('Server error'); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  let validOrigin = false;
  try { validOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* Reject missing or invalid origins. */ }
  if (req.url !== '/ws' || !validOrigin) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
function view() { return { type: 'state', ...controller.view(), persistenceError }; }
function broadcast() {
  const message = JSON.stringify(view());
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(message);
}
// Serialize transport changes across every connected browser.
let commands = Promise.resolve();
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.send(JSON.stringify(view()));
  ws.on('error', () => {});
  ws.on('message', data => {
    commands = commands.then(async () => {
      let message;
      try {
        message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object') throw new Error('Invalid command.');
        await controller.command(message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(view()));
          ws.send(JSON.stringify({ type: 'ack', requestId: message.requestId }));
        }
      } catch (e) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', requestId: message?.requestId, message: e.message }));
      }
    });
  });
});
let lastBroadcast = 0;
const ticker = setInterval(() => {
  const fading = controller.tick();
  output.send();
  const now = Date.now();
  if ((dirty || fading || output.status.connected) && now - lastBroadcast >= 100) {
    broadcast(); dirty = false; lastBroadcast = now;
  }
}, 1000 / 30);
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    else { ws.alive = false; ws.ping(); ws.send(JSON.stringify({ type: 'heartbeat' })); }
  }
}, 15000);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => console.log(`DMX Control listening on http://${host}:${server.address().port}`));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker); clearInterval(heartbeat); clearTimeout(persistTimer);
  const emergencyExit = setTimeout(() => process.exit(1), 7000);
  await commands;
  try { await output.disconnectAll(); } catch (e) { console.error(e.message); }
  await persist();
  for (const ws of wss.clients) ws.close();
  wss.close();
  server.close(() => { clearTimeout(emergencyExit); process.exit(0); });
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
