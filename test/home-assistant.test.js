import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Aedes } from 'aedes';
import { connectAsync } from 'mqtt';
import { WebSocket } from 'ws';
import { defaultState, renderDmx } from '../server/fixtures.js';
import { Adapters } from '../server/adapters.js';
import { Controller } from '../server/controller.js';

async function until(condition, message = 'condition') {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Timed out: ${message}`); await delay(10); }
}
async function broker(t, options = {}) {
  const aedes = await Aedes.createBroker(options), server = net.createServer(aedes.handle), sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await aedes.close(); await new Promise(resolve => server.close(resolve)); });
  return { aedes, url: `mqtt://127.0.0.1:${server.address().port}` };
}
async function observer(t, url) {
  const client = await connectAsync(url, { reconnectPeriod: 0 }), messages = [];
  t.after(() => client.endAsync(true));
  client.on('message', (topic, payload, packet) => messages.push({ topic, payload: payload.toString(), retain: packet.retain }));
  await client.subscribeAsync(['homeassistant/#', 'dmxcontrol/#']);
  return { client, messages,
    configs: () => {
      const configs = new Map();
      for (const message of messages.filter(m => m.topic.endsWith('/config'))) {
        // Like HA, treat an empty discovery payload as removal, including
        // a live removal arriving alongside the initial retained messages.
        if (message.payload) configs.set(message.topic, JSON.parse(message.payload));
        else configs.delete(message.topic);
      }
      return configs;
    },
    latest: topic => messages.findLast(m => m.topic === topic)?.payload,
  };
}
function stateFor(url) {
  const state = defaultState();
  state.adapters.push({ id: 'house', name: 'House', config: { ...state.adapters[0].config, mode: 'mqtt', mqttUrl: url } });
  return state;
}
function desk(t, state) {
  const recalls = [];
  const outputs = new Adapters(state, undefined, undefined, () => !!controller.fade, message => { recalls.push(message); return controller.command(message); });
  const controller = new Controller(state, outputs);
  const timer = setInterval(() => outputs.send(), 20);
  t.after(async () => { clearInterval(timer); await outputs.disconnectAll(); });
  return { outputs, controller, recalls };
}

test('saved scenes become retained HA buttons and additions, renames, and deletions stay in sync', { timeout: 10000 }, async t => {
  const b = await broker(t), ha = await observer(t, b.url), state = stateFor(b.url);
  const { outputs, controller } = desk(t, state);
  await controller.command({ type: 'connect', adapterId: 'house' });
  await until(() => ha.configs().size === state.scenes.length, 'scene discovery');
  const configs = ha.configs();
  for (const scene of state.scenes) {
    const config = [...configs.values()].find(c => c.payload_press === scene.id);
    assert.equal(config.name, scene.name); assert.equal(config.retain, false); assert.equal(config.qos, 0);
    assert.equal(config.device.name, 'DMX Control'); assert.equal(ha.latest(config.availability_topic), 'online');
  }
  assert.equal(state.activeScene, null); assert.equal(state.blackout, false);
  await controller.command({ type: 'saveScene', name: 'Dinner', fade: 2, fixtureIds: ['wash-1'] });
  const id = state.scenes.at(-1).id;
  await until(() => [...ha.configs().values()].some(c => c?.payload_press === id));
  const [topic, config] = [...ha.configs()].find(([, c]) => c.payload_press === id);
  await controller.command({ type: 'updateScene', id, name: 'Evening', fade: 0, fixtureIds: ['wash-1'] });
  await until(() => ha.configs().get(topic)?.name === 'Evening');
  assert.equal(ha.configs().get(topic).unique_id, config.unique_id);
  await controller.command({ type: 'deleteScene', id });
  await until(() => ha.latest(topic) === '', 'deleted button cleared');
  const late = await observer(t, b.url);
  await until(() => late.configs().size === state.scenes.length, 'retained discovery for a late HA subscriber');
  assert.equal(late.configs().has(topic), false);
  for (const topic of late.configs().keys()) assert.ok(late.messages.some(m => m.topic === topic && m.payload && m.retain));
  await outputs.disconnect('house');
  await until(() => ha.latest(config.availability_topic) === 'offline', 'clean disconnect availability');
});

test('HA button presses recall selected-light scenes with their fade and preserve other lights and blackout', { timeout: 10000 }, async t => {
  const b = await broker(t), ha = await observer(t, b.url), state = stateFor(b.url);
  const { controller, recalls } = desk(t, state);
  state.fixtures[0].levels.intensity = 24;
  await controller.command({ type: 'saveScene', name: 'Left wash', fade: 2, fixtureIds: ['wash-1'] });
  const scene = state.scenes.at(-1);
  await controller.command({ type: 'levels', ids: ['wash-1'], levels: { intensity: 88 } });
  state.master = 35; state.blackout = true;
  const excluded = structuredClone(state.fixtures[1]);
  await controller.command({ type: 'connect', adapterId: 'house' });
  await until(() => [...ha.configs().values()].some(c => c.payload_press === scene.id));
  const config = [...ha.configs().values()].find(c => c.payload_press === scene.id);
  await ha.client.publishAsync(config.command_topic, config.payload_press, { qos: config.qos, retain: config.retain });
  await until(() => state.activeScene === scene.id);
  assert.equal(controller.fade.duration, 2000);
  controller.tick(controller.fade.start + 1000); assert.ok(Math.abs(state.fixtures[0].levels.intensity - 56) < 1e-9);
  controller.tick(controller.fade.start + 2001); assert.equal(state.fixtures[0].levels.intensity, 24);
  assert.deepEqual(state.fixtures[1], excluded); assert.equal(state.master, 35); assert.equal(state.blackout, true);
  assert.equal(recalls.length, 1);
  for (const payload of ['', 'unknown-scene', '{"type":"blackout","value":false}']) await ha.client.publishAsync(config.command_topic, payload);
  const beforeBirth = ha.messages.filter(m => m.topic.endsWith('/config')).length;
  await ha.client.publishAsync('homeassistant/status', 'online');
  await until(() => ha.messages.filter(m => m.topic.endsWith('/config')).length >= beforeBirth + state.scenes.length, 'rediscovery after HA restart');
  assert.equal(recalls.length, 1); assert.equal(state.blackout, true);
});

test('reconnect publishes availability and fresh discovery without replaying retained scene commands', { timeout: 12000 }, async t => {
  const b = await broker(t), ha = await observer(t, b.url), state = stateFor(b.url);
  const { outputs, controller, recalls } = desk(t, state), output = outputs.get('house');
  await ha.client.publishAsync(output.scenes.commandTopic, state.scenes[0].id, { retain: true });
  await controller.command({ type: 'connect', adapterId: 'house' });
  await until(() => ha.configs().size === state.scenes.length);
  assert.equal(recalls.length, 0); assert.equal(state.activeScene, null);
  const deleted = state.scenes[0], [deletedTopic] = [...ha.configs()].find(([, c]) => c.payload_press === deleted.id);
  b.aedes.clients[`dmx-${output.cid}`].conn.destroy();
  await until(() => !output.status.connected);
  await until(() => ha.latest(output.scenes.availabilityTopic) === 'offline', 'last will');
  await controller.command({ type: 'deleteScene', id: deleted.id });
  await ha.client.publishAsync(output.scenes.commandTopic, state.scenes[0].id, { retain: true });
  await until(() => output.status.connected, 'reconnect');
  await until(() => ha.latest(deletedTopic) === '', 'offline deletion reconciled');
  await until(() => ha.latest(output.scenes.availabilityTopic) === 'online');
  assert.equal(recalls.length, 0); assert.equal(state.activeScene, null);
  await ha.client.publishAsync(output.scenes.commandTopic, state.scenes[0].id);
  await until(() => recalls.length === 1);
});

test('new process state reconciles stale buttons and deleting every scene clears retained discovery', { timeout: 10000 }, async t => {
  const b = await broker(t), ha = await observer(t, b.url), state = stateFor(b.url);
  const original = desk(t, state);
  await original.outputs.connect('house');
  await until(() => ha.configs().size === state.scenes.length);
  const old = [...ha.configs()];
  await original.outputs.disconnectAll();
  const restored = structuredClone(state); restored.scenes = [restored.scenes[0]]; restored.scenes[0].name = 'Renamed while stopped';
  const fresh = desk(t, restored);
  await fresh.outputs.connect('house');
  await until(() => ha.configs().size === 1, 'old process discovery cleared');
  const [topic, config] = [...ha.configs()].find(([, c]) => c);
  assert.equal(config.name, 'Renamed while stopped');
  assert.equal(config.unique_id, old.find(([t]) => t === topic)[1].unique_id);
  await fresh.controller.command({ type: 'deleteScene', id: restored.scenes[0].id });
  await until(() => ha.configs().size === 0);
});

test('multiple MQTT adapters on one broker expose one set of buttons and handle each press once, including failover', { timeout: 10000 }, async t => {
  const b = await broker(t), ha = await observer(t, b.url), state = stateFor(b.url);
  state.adapters.push({ id: 'other-house', name: 'Other bridge', config: { ...state.adapters[1].config, mqttBaseTopic: 'other-zigbee' } });
  const { outputs, recalls } = desk(t, state);
  await outputs.connect('house'); await outputs.connect('other-house');
  await until(() => ha.configs().size === state.scenes.length);
  const config = [...ha.configs().values()][0];
  await ha.client.publishAsync(config.command_topic, config.payload_press);
  await until(() => recalls.length === 1); await delay(100); assert.equal(recalls.length, 1);
  await outputs.disconnect('house');
  await until(() => [...ha.configs().values()].every(c => c.availability_topic === outputs.get('other-house').scenes.availabilityTopic), 'remaining adapter takes over');
  assert.equal(ha.configs().size, state.scenes.length);
  await ha.client.publishAsync(config.command_topic, config.payload_press);
  await until(() => recalls.length === 2); await delay(100); assert.equal(recalls.length, 2);
});

for (const savedBlackout of [false, true]) test(`server starts with blackout off when saved blackout=${savedBlackout}, auto-connects DMX and MQTT, and accepts HA presses`, { timeout: 20000 }, async t => {
  let mqttReady = true, olaReady = !savedBlackout;
  const b = await broker(t, { authenticate(client, username, password, callback) { callback(null, mqttReady); } });
  const ha = await observer(t, b.url), state = stateFor(b.url), olaRequests = [], dimmerCommands = [];
  // On one run, both services initially fail to exercise boot-time retries.
  mqttReady = !savedBlackout;
  b.aedes.on('publish', (packet, client) => { if (client && packet.topic === 'zigbee2mqtt/house/lobby/set') dimmerCommands.push(JSON.parse(packet.payload)); });
  const ola = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    olaRequests.push(Buffer.from(new URLSearchParams(body).get('d').split(',').map(Number)));
    res.writeHead(olaReady ? 200 : 503); res.end(olaReady ? 'ok' : 'Starting OLA');
  });
  ola.listen(0, '127.0.0.1'); await once(ola, 'listening');
  t.after(() => { ola.closeAllConnections(); ola.close(); });
  Object.assign(state.adapters[0].config, { mode: 'usb', olaUrl: `http://127.0.0.1:${ola.address().port}` });
  state.blackout = savedBlackout;
  state.fixtures.push({ ...structuredClone(state.fixtures[0]), id: 'lobby', adapterId: 'house', mqttDevice: 'house/lobby', mqttMaxBrightness: 254, followDesk: false });
  state.scenes[0].fade = 0;
  const scene = state.scenes[0];
  scene.fixtures.lobby = { ...state.fixtures.at(-1).levels, intensity: 33 };
  const dir = await mkdtemp(path.join(tmpdir(), 'dmx-ha-test-'));
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, DMX_DATA_DIR: dir, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } await rm(dir, { recursive: true, force: true }); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  await until(() => /127\.0\.0\.1:(\d+)/.test(stdout) || child.exitCode !== null, 'server startup');
  assert.equal(child.exitCode, null, stderr);
  const url = `http://127.0.0.1:${stdout.match(/127\.0\.0\.1:(\d+)/)[1]}`;
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { origin: url }), states = [];
  t.after(() => ws.terminate());
  ws.on('message', payload => { const message = JSON.parse(payload); if (message.type === 'state') states.push(message); });
  await once(ws, 'open');
  if (savedBlackout) {
    await until(() => states.at(-1)?.adapterStatuses.main.error?.includes('Retrying startup') && states.at(-1)?.adapterStatuses.house.error?.includes('Retrying startup'), 'startup failures reported');
    assert.equal((await (await fetch(`${url}/api/health`)).json()).ok, true);
    mqttReady = true;
  }
  await until(() => ha.configs().size === state.scenes.length);
  if (savedBlackout) {
    assert.equal(states.at(-1).adapterStatuses.main.connected, false, 'MQTT connected independently while OLA was unavailable');
    olaReady = true;
  }
  await until(() => states.at(-1)?.adapterStatuses.main.connected && states.at(-1)?.adapterStatuses.house.connected, 'both saved adapters connect automatically');
  assert.ok(states.every(s => s.blackout === false), 'blackout is cleared before broadcasting startup state');
  assert.equal(states.at(-1).activeScene, null);
  assert.deepEqual(olaRequests[0], renderDmx({ ...state, blackout: false }));
  assert.ok(olaRequests[0].some(value => value > 0), 'saved DMX levels are visible from the first startup frame');
  assert.equal(dimmerCommands.length, 0, 'startup does not replay saved house brightness');
  const config = [...ha.configs().values()].find(c => c.payload_press === scene.id);
  await ha.client.publishAsync(config.command_topic, config.payload_press);
  await until(() => states.at(-1)?.activeScene === scene.id, 'scene reflected in browser');
  assert.equal(states.at(-1).master, scene.master);
  assert.deepEqual(states.at(-1).fixtures[0].levels, scene.fixtures['wash-1']);
  assert.equal(states.at(-1).blackout, false);
  await until(() => dimmerCommands.length === 1 && olaRequests.at(-1).equals(renderDmx(states.at(-1))), 'HA scene reaches both physical output transports');
  assert.deepEqual(dimmerCommands[0], { state: 'ON', brightness: 84 });
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  assert.equal(child.exitCode, 0, stderr);
  const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.activeScene, scene.id); assert.deepEqual(saved.fixtures[0].levels, scene.fixtures['wash-1']);
  assert.equal(saved.blackout, false);
  await until(() => ha.latest(config.availability_topic) === 'offline');
});
