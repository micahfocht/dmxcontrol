import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { defaultState } from '../server/fixtures.js';
import { Output } from '../server/output.js';
import { Adapters } from '../server/adapters.js';
import { setTimeout as delay } from 'node:timers/promises';

test('sACN sends to a real local UDP receiver and disconnects with blackout and three termination packets', async t => {
  const receiver = dgram.createSocket('udp4');
  receiver.bind(5568, '127.0.0.1'); await once(receiver, 'listening');
  t.after(() => receiver.close());
  const packets = []; receiver.on('message', packet => packets.push(packet));
  const state = defaultState(), output = new Output(state.cid);
  t.after(() => output.disconnect());
  await output.connect({ ...state.adapters[0].config, mode: 'sacn', universe: 19, destination: '127.0.0.1' });
  const slots = Buffer.alloc(512); slots[0] = 254;
  const received = once(receiver, 'message'); output.send(slots); await received; await output.pending;
  assert.equal(packets[0][126], 254); assert.equal(packets[0].readUInt16BE(113), 19);
  assert.equal(output.status.frames, 1);
  const terminated = new Promise(resolve => { receiver.on('message', () => { if (packets.length === 5) resolve(); }); });
  await output.disconnect(); await terminated;
  assert.equal(packets.length, 5);
  assert.ok(packets[1].subarray(126).every(v => v === 0));
  assert.deepEqual(packets.slice(2).map(p => p[112]), [64, 64, 64]);
  assert.deepEqual(packets.map(p => p[111]), [0, 1, 2, 3, 4]);
  assert.equal(output.status.connected, false);
});

test('USB via OLA posts all 512 channels, limits pending requests, and sends blackout before disconnect', async t => {
  const requests = [], mock = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push({ path: req.url, data: new URLSearchParams(body) });
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const state = defaultState(), output = new Output(state.cid);
  await output.connect({ ...state.adapters[0].config, mode: 'usb', olaUniverse: 7, olaUrl: `http://127.0.0.1:${mock.address().port}` });
  const slots = Buffer.alloc(512); slots[511] = 99;
  output.send(slots); output.send(Buffer.alloc(512, 255)); await output.pending;
  await output.disconnect();
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.path === '/set_dmx' && r.data.get('u') === '7'));
  assert.equal(requests[0].data.get('d').split(',').length, 512);
  assert.equal(requests[1].data.get('d').split(',').at(-1), '99');
  assert.ok(requests[2].data.get('d').split(',').every(v => v === '0'));
});

test('OLA errors are visible and do not claim that physical output is connected', async t => {
  const mock = http.createServer((req, res) => { req.resume(); res.writeHead(200); res.end('{"error":"Universe not found"}'); });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const state = defaultState(), output = new Output(state.cid);
  await assert.rejects(output.connect({ ...state.adapters[0].config, mode: 'usb', olaUrl: `http://127.0.0.1:${mock.address().port}` }), /Universe not found/);
  assert.equal(output.status.connected, false); assert.equal(output.status.connecting, false);
  assert.match(output.status.error, /OLA/);
});

test('two sACN adapters simultaneously send isolated universes and global blackout', { timeout: 5000 }, async t => {
  const receiver = dgram.createSocket('udp4'); receiver.bind(5568, '127.0.0.1'); await once(receiver, 'listening');
  t.after(() => receiver.close());
  const packets = []; receiver.on('message', p => packets.push(p));
  const state = defaultState(), config = { ...state.adapters[0].config, mode: 'sacn', destination: '127.0.0.1' };
  state.adapters = [{ id: 'main', name: 'Left node', config }, { id: 'right', name: 'Right node', config: { ...config, universe: 2 } }];
  state.fixtures[1].adapterId = 'right'; state.fixtures[1].address = 1; state.master = 100;
  state.fixtures[0].levels = { ...state.fixtures[0].levels, intensity: 100, red: 100, green: 0, blue: 0 };
  state.fixtures[1].levels = { ...state.fixtures[1].levels, intensity: 100, red: 0, green: 0, blue: 100 };
  const outputs = new Adapters(state); t.after(() => outputs.disconnectAll());
  await outputs.connect('main'); await outputs.connect('right'); outputs.send();
  await Promise.all([...outputs.outputs.values()].map(o => o.pending));
  while (packets.length < 2) await delay(5);
  const byUniverse = new Map(packets.map(p => [p.readUInt16BE(113), p]));
  assert.deepEqual([...byUniverse.get(1).subarray(126, 132)], [255, 0, 0, 0, 0, 0]);
  assert.deepEqual([...byUniverse.get(2).subarray(126, 132)], [0, 0, 255, 0, 0, 0]);
  assert.notDeepEqual(byUniverse.get(1).subarray(22, 38), byUniverse.get(2).subarray(22, 38));
  assert.equal(outputs.status.connectedCount, 2);
  state.blackout = true; outputs.send(); await Promise.all([...outputs.outputs.values()].map(o => o.pending));
  while (packets.length < 4) await delay(5);
  assert.ok(packets.slice(2, 4).every(p => p.subarray(126).every(v => v === 0)));
  await outputs.disconnectAll(); assert.equal(outputs.status.connectedCount, 0);
});
