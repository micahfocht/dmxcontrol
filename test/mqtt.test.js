import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Aedes } from 'aedes';
import { defaultState, validatePatch } from '../server/fixtures.js';
import { validateOutput } from '../server/output.js';
import { Adapters, validateAdapters } from '../server/adapters.js';
import { Controller } from '../server/controller.js';
import { MqttOutput, dimmerCommand } from '../server/mqtt.js';

async function until(condition, message = 'condition') {
  const deadline = Date.now() + 3500;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Timed out: ${message}`); await delay(10); }
}
function setup() {
  const state = defaultState(), config = validateOutput({ ...state.adapters[0].config, mode: 'mqtt' });
  state.adapters.push({ id: 'house', name: 'House lights', config });
  state.fixtures.push({ ...structuredClone(state.fixtures[0]), id: 'house-1', name: 'House left', adapterId: 'house', mqttDevice: 'house/left', mqttMaxBrightness: 254, followDesk: false });
  state.fixtures = validatePatch(state.fixtures, state.adapters);
  return { state, config, fixture: state.fixtures.at(-1) };
}
async function broker(t, options = {}) {
  const aedes = await Aedes.createBroker(options), server = net.createServer(aedes.handle);
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { sockets.forEach(s => s.destroy()); await aedes.close(); await new Promise(resolve => server.close(resolve)); });
  return { aedes, url: `mqtt://127.0.0.1:${server.address().port}`, publish: (topic, payload, retain = false) => new Promise((resolve, reject) => aedes.publish({ cmd: 'publish', topic, payload: Buffer.from(JSON.stringify(payload)), qos: 0, retain }, e => e ? reject(e) : resolve())) };
}

test('MQTT validates URLs, credentials, topic names, and duplicate broker connections', () => {
  const config = defaultState().adapters[0].config;
  assert.equal(validateOutput({ ...config, mqttUrl: 'mqtts://example.local' }).mqttUrl, 'mqtts://example.local:8883');
  for (const mqttUrl of ['http://host', 'mqtt://name:secret@host', 'mqtt://host/path', 'mqtt://host?password=x', 'mqtt://host:0']) assert.throws(() => validateOutput({ ...config, mqttUrl }));
  for (const mqttBaseTopic of ['', '#', 'zigbee/+', ' /invalid ', 'invalid/ ']) assert.throws(() => validateOutput({ ...config, mqttBaseTopic }));
  const mqtt = { ...config, mode: 'mqtt' };
  assert.throws(() => validateAdapters([{ id: 'a', name: 'A', config: mqtt }, { id: 'b', name: 'B', config: mqtt }]), /already uses/);
});

test('MQTT fixtures use device names rather than DMX addresses, reject duplicates, and default to independent house lighting', () => {
  const { state, fixture } = setup();
  assert.equal(fixture.channels.length, 1); assert.equal(fixture.channels[0].kind, 'dimmer');
  const second = { ...structuredClone(fixture), id: 'house-2', mqttDevice: 'house/right' };
  assert.doesNotThrow(() => validatePatch([...state.fixtures, second], state.adapters));
  assert.throws(() => validatePatch([...state.fixtures, { ...second, mqttDevice: fixture.mqttDevice }], state.adapters), /already assigned/);
  for (const mqttDevice of ['bridge', 'bridge/request', 'bad/#', '', '/device']) assert.throws(() => validatePatch([{ ...fixture, mqttDevice }], state.adapters));
  state.master = 20; state.blackout = true; fixture.levels.intensity = 50;
  assert.deepEqual(dimmerCommand(fixture, state), { state: 'ON', brightness: 127 });
  fixture.followDesk = true;
  assert.deepEqual(dimmerCommand(fixture, state), { state: 'OFF' });
  state.blackout = false;
  assert.deepEqual(dimmerCommand(fixture, state), { state: 'ON', brightness: 25 });
});

test('broker passwords are write-only in browser state and persist across unrelated settings edits', async () => {
  const { state } = setup(), outputs = new Adapters(state), c = new Controller(state, outputs);
  await c.command({ type: 'output', adapterId: 'house', name: 'Mosquitto', config: { ...state.adapters[1].config, mqttUsername: 'desk', mqttPassword: 'test-only-password' } });
  const view = c.view();
  assert.equal(view.adapters[1].config.mqttPassword, undefined); assert.equal(view.adapters[1].config.mqttPasswordSet, true);
  assert.equal(JSON.stringify(view).includes('test-only-password'), false);
  await c.command({ type: 'output', adapterId: 'house', name: 'Renamed', config: { ...view.adapters[1].config, mqttBaseTopic: 'lights' } });
  assert.equal(state.adapters[1].config.mqttPassword, 'test-only-password');
  await c.command({ type: 'output', adapterId: 'house', name: 'Renamed', config: { ...c.view().adapters[1].config, mqttPassword: '' } });
  assert.equal(state.adapters[1].config.mqttPassword, '');
});

test('a real broker receives only changed non-retained dimmer commands; connecting and disconnecting preserve house levels', { timeout: 8000 }, async t => {
  const b = await broker(t), { state, config, fixture } = setup();
  const commands = []; b.aedes.on('publish', (packet, client) => { if (client && packet.topic.endsWith('/set')) commands.push(packet); });
  await b.publish('zigbee2mqtt/house/left', { state: 'ON', brightness: 127 }, true);
  const output = new MqttOutput(state, 'house', state.cid); t.after(() => output.disconnect());
  await output.connect({ ...config, mqttUrl: b.url });
  await until(() => output.status.reported[fixture.id]?.level === 50, 'retained brightness feedback');
  assert.equal(fixture.levels.intensity, 50);
  output.send(); await delay(100); assert.equal(commands.length, 0);
  fixture.levels.intensity = 100; output.send(); await output.pending;
  await until(() => commands.length === 1);
  assert.deepEqual(JSON.parse(commands[0].payload), { state: 'ON', brightness: 254 });
  assert.equal(commands[0].retain, false); assert.equal(commands[0].qos, 0);
  for (let i = 0; i < 30; i++) output.send(); await delay(220);
  assert.equal(commands.length, 1);
  fixture.levels.intensity = 0; output.send(); await output.pending;
  await until(() => commands.length === 2); assert.deepEqual(JSON.parse(commands[1].payload), { state: 'OFF' });
  await output.disconnect(); await delay(50); assert.equal(commands.length, 2);
});

test('reported HA/wall changes update the desk without a command echo, and discovery extracts brightness capabilities', { timeout: 8000 }, async t => {
  const b = await broker(t), { state, config, fixture } = setup();
  const commands = []; b.aedes.on('publish', (p, client) => { if (client && p.topic.endsWith('/set')) commands.push(p); });
  await b.publish('zigbee2mqtt/bridge/devices', [{ friendly_name: 'house/left', definition: { exposes: [{ type: 'light', features: [{ property: 'brightness', access: 7, value_max: 254 }] }] } }], true);
  const output = new MqttOutput(state, 'house', state.cid); t.after(() => output.disconnect());
  await output.connect({ ...config, mqttUrl: b.url });
  await until(() => output.status.devices.length === 1);
  assert.deepEqual(output.status.devices[0], { name: 'house/left', maxBrightness: 254 });
  await b.publish('zigbee2mqtt/house/left', { state: 'ON', brightness: 63.5 });
  await until(() => fixture.levels.intensity === 25);
  output.send(); await delay(100); assert.equal(commands.length, 0);
  await b.publish('zigbee2mqtt/house/left', { state: 'OFF', brightness: 63.5 });
  await until(() => fixture.levels.intensity === 0);
  output.send(); await delay(50); assert.equal(commands.length, 0);
});

test('MQTT rate limiting coalesces rapid fader changes, preserves the final value, and respects device availability', { timeout: 8000 }, async t => {
  const b = await broker(t), { state, config, fixture } = setup();
  const commands = []; b.aedes.on('publish', (p, client) => { if (client && p.topic.endsWith('/set')) commands.push(p); });
  const output = new MqttOutput(state, 'house', state.cid); t.after(() => output.disconnect());
  await output.connect({ ...config, mqttUrl: b.url });
  fixture.levels.intensity = 10; output.send(); await output.pending; await until(() => commands.length === 1);
  for (let i = 11; i <= 90; i++) { fixture.levels.intensity = i; output.send(); }
  assert.equal(commands.length, 1);
  await delay(220); output.send(); await output.pending; await until(() => commands.length === 2);
  assert.equal(JSON.parse(commands[1].payload).brightness, 229);
  await b.publish('zigbee2mqtt/house/left/availability', { state: 'offline' });
  await until(() => output.status.reported[fixture.id].available === false);
  fixture.levels.intensity = 50; output.send();
  await b.publish('zigbee2mqtt/house/left/availability', { state: 'online' });
  await until(() => output.status.reported[fixture.id].available === true);
  await delay(220); output.send(); await delay(50); assert.equal(commands.length, 2);
});

test('MQTT reconnect resubscribes without replaying changes made while disconnected', { timeout: 10000 }, async t => {
  const b = await broker(t), { state, config, fixture } = setup();
  const commands = []; b.aedes.on('publish', (p, client) => { if (client && p.topic.endsWith('/set')) commands.push(p); });
  const output = new MqttOutput(state, 'house', state.cid); t.after(() => output.disconnect());
  await output.connect({ ...config, mqttUrl: b.url });
  b.aedes.clients[`dmx-${state.cid}`].conn.destroy();
  await until(() => !output.status.connected);
  fixture.levels.intensity = 42; output.send();
  await until(() => output.status.connected, 'broker reconnect');
  output.send(); await delay(100); assert.equal(commands.length, 0);
  await b.publish('zigbee2mqtt/house/left', { state: 'ON', brightness: 127 });
  await until(() => fixture.levels.intensity === 50, 'resubscribed state');
});

test('MQTT authentication failures report an error and close the connection', { timeout: 8000 }, async t => {
  const b = await broker(t, { authenticate(client, username, password, callback) { callback(null, username === 'desk' && password?.toString() === 'correct'); } });
  const { state, config } = setup(), output = new MqttOutput(state, 'house', state.cid); t.after(() => output.disconnect());
  await assert.rejects(output.connect({ ...config, mqttUrl: b.url, mqttUsername: 'desk', mqttPassword: 'wrong' }), /MQTT/);
  assert.equal(output.status.connected, false); assert.equal(output.client, null);
  assert.equal(output.status.error.includes('wrong'), false);
  await output.connect({ ...config, mqttUrl: b.url, mqttUsername: 'desk', mqttPassword: 'correct' });
  assert.equal(output.status.connected, true);
});

test('MQTT scene levels work alongside DMX while connect does not engage stage blackout', { timeout: 8000 }, async t => {
  const b = await broker(t), { state, fixture } = setup(); state.adapters[1].config.mqttUrl = b.url;
  const outputs = new Adapters(state), c = new Controller(state, outputs); t.after(() => outputs.disconnectAll());
  state.blackout = false;
  await c.command({ type: 'connect', adapterId: 'house' }); assert.equal(state.blackout, false);
  fixture.levels.intensity = 33;
  await c.command({ type: 'saveScene', name: 'House look', fade: 0 }); const scene = state.scenes.at(-1);
  await c.command({ type: 'levels', ids: [fixture.id], levels: { intensity: 75 } });
  await c.command({ type: 'recallScene', id: scene.id }); assert.equal(fixture.levels.intensity, 33);
  assert.equal(state.fixtures[0].levels.intensity, 75);
});

test('an explicit blackout applies to opted-in house lights even when the desk was already blacked out at connect', { timeout: 8000 }, async t => {
  const b = await broker(t), { state, fixture } = setup(); state.adapters[1].config.mqttUrl = b.url;
  state.blackout = true; fixture.followDesk = true;
  const commands = []; b.aedes.on('publish', (p, client) => { if (client && p.topic.endsWith('/set')) commands.push(p); });
  const outputs = new Adapters(state), c = new Controller(state, outputs); t.after(() => outputs.disconnectAll());
  await c.command({ type: 'connect', adapterId: 'house' }); outputs.send(); await delay(50);
  assert.equal(commands.length, 0);
  await c.command({ type: 'blackout', value: true }); outputs.send();
  await outputs.get('house').pending; await until(() => commands.length === 1);
  assert.deepEqual(JSON.parse(commands[0].payload), { state: 'OFF' });
});
