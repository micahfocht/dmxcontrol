import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { artnetPacket } from '../server/protocol.js';
import { Output, validateOutput } from '../server/output.js';
import { Adapters, validateAdapters } from '../server/adapters.js';
import { defaultState } from '../server/fixtures.js';

test('ArtDmx encodes its opcode, protocol revision, 15-bit address and all 512 slots correctly', () => {
  const slots = Buffer.alloc(512); slots[0] = 125; slots[511] = 239;
  const packet = artnetPacket({ universe: 0x1234, sequence: 255 }, slots);
  assert.equal(packet.length, 530);
  assert.equal(packet.toString('ascii', 0, 8), 'Art-Net\0');
  assert.equal(packet.readUInt16LE(8), 0x5000);
  assert.equal(packet.readUInt16BE(10), 14);
  assert.equal(packet[12], 255); assert.equal(packet[13], 0);
  assert.equal(packet[14], 0x34); assert.equal(packet[15], 0x12);
  assert.equal(packet.readUInt16BE(16), 512);
  assert.deepEqual(packet.subarray(18), slots);
  const first = artnetPacket({ universe: 0 }, slots), last = artnetPacket({ universe: 32767 }, slots);
  assert.deepEqual([...first.subarray(14, 16)], [0, 0]);
  assert.deepEqual([...last.subarray(14, 16)], [255, 127]);
  for (const universe of [-1, 32768, 1.5]) assert.throws(() => artnetPacket({ universe }, slots), /port-address/);
  assert.throws(() => artnetPacket({ universe: 0 }, Buffer.alloc(513)), /512/);
});

test('Art-Net requires a node IP and permits independent sACN and Art-Net address ranges', () => {
  const config = { ...defaultState().adapters[0].config, mode: 'artnet', destination: '192.168.1.20' };
  assert.equal(validateOutput(config).artnetUniverse, 0);
  assert.equal(validateOutput({ ...config, universe: 63999, artnetUniverse: 32767 }).artnetUniverse, 32767);
  for (const destination of ['', '0.0.0.0', '239.255.0.1', '255.255.255.255', 'node.local', '::1']) assert.throws(() => validateOutput({ ...config, destination }));
  for (const artnetUniverse of [-1, 32768, 2.5]) assert.throws(() => validateOutput({ ...config, artnetUniverse }), /port-address/);
  const { artnetUniverse, ...oldConfig } = defaultState().adapters[0].config;
  assert.equal(validateOutput(oldConfig).artnetUniverse, 0);
});

test('Art-Net rejects competing adapter routes and allows separate nodes or universes', () => {
  const config = { ...defaultState().adapters[0].config, mode: 'artnet', destination: '192.168.1.20', artnetUniverse: 0 };
  const a = { id: 'a', name: 'Left', config }, b = { id: 'b', name: 'Right', config };
  assert.throws(() => validateAdapters([a, b]), /already uses/);
  assert.doesNotThrow(() => validateAdapters([a, { ...b, config: { ...config, artnetUniverse: 1 } }]));
  assert.doesNotThrow(() => validateAdapters([a, { ...b, config: { ...config, destination: '192.168.1.21' } }]));
  assert.doesNotThrow(() => validateAdapters([a, { ...b, config: { ...config, mode: 'sacn' } }]));
});

test('Art-Net sends from UDP 6454, sequences 255→1, and sends a final blackout on disconnect', { timeout: 5000 }, async t => {
  const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  receiver.bind(6454, '127.0.0.2'); await once(receiver, 'listening');
  t.after(() => receiver.close());
  const state = defaultState(), output = new Output(state.cid);
  t.after(() => output.disconnect());
  await output.connect({ ...state.adapters[0].config, mode: 'artnet', artnetUniverse: 500, destination: '127.0.0.2', interface: '127.0.0.1' });
  output.sequence = 254;
  const slots = Buffer.alloc(512); slots[0] = 71; slots[511] = 99;
  let received = once(receiver, 'message'); output.send(slots);
  const [first, remote] = await received; await output.pending;
  assert.equal(remote.port, 6454); assert.equal(remote.address, '127.0.0.1');
  assert.equal(first[12], 255); assert.equal(first[14] | first[15] << 8, 500);
  assert.equal(first[18], 71); assert.equal(first[529], 99);
  received = once(receiver, 'message'); output.send(slots);
  const [second] = await received; await output.pending;
  assert.equal(second[12], 1);
  received = once(receiver, 'message'); await output.disconnect(); const [blackout] = await received;
  assert.equal(blackout[12], 2); assert.ok(blackout.subarray(18).every(v => v === 0));
  assert.equal(output.status.connected, false);
});

test('multiple Art-Net adapters share the controller port, route isolated buffers, and disconnect independently', { timeout: 5000 }, async t => {
  const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  receiver.bind(6454, '127.0.0.2'); await once(receiver, 'listening'); t.after(() => receiver.close());
  const packets = []; receiver.on('message', p => packets.push(p));
  const state = defaultState(), config = { ...state.adapters[0].config, mode: 'artnet', destination: '127.0.0.2', interface: '127.0.0.1' };
  state.adapters = [{ id: 'main', name: 'Left', config }, { id: 'right', name: 'Right', config: { ...config, artnetUniverse: 1 } }];
  state.fixtures[1].adapterId = 'right'; state.fixtures[1].address = 1; state.master = 100;
  state.fixtures[0].levels = { ...state.fixtures[0].levels, intensity: 100, red: 100, green: 0, blue: 0 };
  state.fixtures[1].levels = { ...state.fixtures[1].levels, intensity: 100, red: 0, green: 0, blue: 100 };
  const outputs = new Adapters(state); t.after(() => outputs.disconnectAll());
  await outputs.connect('main'); await outputs.connect('right'); outputs.send();
  await Promise.all([...outputs.outputs.values()].map(o => o.pending));
  while (packets.length < 2) await delay(5);
  const byUniverse = new Map(packets.map(p => [p[14] | p[15] << 8, p]));
  assert.deepEqual([...byUniverse.get(0).subarray(18, 24)], [255, 0, 0, 0, 0, 0]);
  assert.deepEqual([...byUniverse.get(1).subarray(18, 24)], [0, 0, 255, 0, 0, 0]);
  await outputs.disconnect('main'); assert.equal(outputs.status.connectedCount, 1);
  state.blackout = true; outputs.send(); await outputs.get('right').pending;
  while (packets.length < 4) await delay(5);
  assert.ok(packets.slice(2).every(p => p.subarray(18).every(v => v === 0)));
  await outputs.disconnectAll(); assert.equal(outputs.status.connectedCount, 0);
});
