import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, renderDmx, validatePatch, BUILTIN_PROFILES } from '../server/fixtures.js';
import { Controller } from '../server/controller.js';
import { validateOutput } from '../server/output.js';
import { sacnPacket, multicastAddress } from '../server/protocol.js';

test('RGB fixtures scale color by fixture intensity and master, blackout clears the whole universe', () => {
  const state = defaultState();
  state.master = 50;
  state.fixtures[0].levels = { ...state.fixtures[0].levels, intensity: 80, red: 100, green: 50, blue: 0 };
  const slots = renderDmx(state);
  assert.equal(slots.length, 512);
  assert.deepEqual([...slots.subarray(0, 3)], [102, 51, 0]);
  assert.equal(slots[6], 0);
  state.blackout = true;
  assert.ok(renderDmx(state).every(v => v === 0));
  assert.equal(state.fixtures[0].levels.intensity, 80);
});

test('a dedicated dimmer scales once; fixed channels and custom channel order are honored', () => {
  const state = defaultState(), fixture = state.fixtures[0];
  state.fixtures = [fixture]; state.master = 50;
  fixture.channels = [
    { kind: 'blue', label: 'B', value: 0 }, { kind: 'dimmer', label: 'D', value: 0 },
    { kind: 'red', label: 'R', value: 0 }, { kind: 'fixed', label: 'Mode', value: 42 },
  ];
  fixture.levels = { ...fixture.levels, intensity: 80, red: 100, blue: 50 };
  assert.deepEqual([...renderDmx(state).subarray(0, 4)], [128, 102, 255, 42]);
  state.blackout = true; assert.equal(renderDmx(state)[3], 0);
});

test('the documented 7-channel profile leaves macros and strobe off', () => {
  const state = defaultState(), fixture = state.fixtures[0];
  state.fixtures = [fixture]; state.master = 100;
  fixture.channels = BUILTIN_PROFILES.find(p => p.id === 'slimpar56-7').channels;
  fixture.levels = { ...fixture.levels, intensity: 50, red: 100, green: 0, blue: 100 };
  assert.deepEqual([...renderDmx(state).subarray(0, 7)], [255, 0, 255, 0, 0, 0, 128]);
});

test('patch rejects collisions, duplicate IDs, invalid channels, and the universe boundary', () => {
  const fixtures = defaultState().fixtures;
  assert.doesNotThrow(() => validatePatch(fixtures));
  const overlap = structuredClone(fixtures); overlap[1].address = 3;
  assert.throws(() => validatePatch(overlap), /overlaps/);
  const boundary = structuredClone(fixtures); boundary[0].address = 511;
  assert.throws(() => validatePatch(boundary), /Start address/);
  const duplicate = structuredClone(fixtures); duplicate[1].id = duplicate[0].id;
  assert.throws(() => validatePatch(duplicate), /unique/);
  const invalid = structuredClone(fixtures); invalid[0].channels[0].kind = 'bogus';
  assert.throws(() => validatePatch(invalid), /Unknown/);
  assert.throws(() => validatePatch([{ ...fixtures[0], x: NaN }]), /between/);
});

test('bad multi-fixture commands are atomic and patch edits retain live levels and positions', async () => {
  const state = defaultState(), c = new Controller(state, {});
  await assert.rejects(c.command({ type: 'levels', ids: ['wash-1', 'missing'], levels: { intensity: 10 } }), /not found/);
  assert.equal(state.fixtures[0].levels.intensity, 75);
  await assert.rejects(c.command({ type: 'position', id: 'wash-1', x: 20, y: 101 }), /between/);
  assert.equal(state.fixtures[0].x, 28);
  const patch = structuredClone(state.fixtures); patch[0].name = 'Renamed'; patch[0].levels.intensity = 0; patch[0].x = 0;
  await c.command({ type: 'patch', fixtures: patch });
  assert.equal(state.fixtures[0].name, 'Renamed'); assert.equal(state.fixtures[0].levels.intensity, 75); assert.equal(state.fixtures[0].x, 28);
});

test('scene fade interpolates levels and master, preserves blackout and positions, and can be interrupted', async () => {
  const state = defaultState(), c = new Controller(state, {});
  state.blackout = true; state.master = 20;
  const before = structuredClone(state.fixtures[0]);
  await c.command({ type: 'recallScene', id: 'blue' });
  const start = c.fade.start;
  c.tick(start + 500);
  assert.ok(Math.abs(state.master - 50) < 1e-8);
  assert.ok(Math.abs(state.fixtures[0].levels.red - (before.levels.red + 24) / 2) < 1e-8);
  assert.equal(state.blackout, true); assert.equal(state.fixtures[0].x, before.x);
  await c.command({ type: 'levels', ids: ['wash-1'], levels: { intensity: 33 } });
  assert.equal(c.fade, null); assert.equal(state.activeScene, null); assert.equal(state.fixtures[0].levels.intensity, 33);
  await c.command({ type: 'recallScene', id: 'blue' }); c.tick(c.fade.start + 1001);
  assert.equal(c.fade, null); assert.equal(state.master, 80); assert.equal(state.fixtures[0].levels.red, 24);
});

test('custom profiles and saved scenes survive patch removal, new fixtures are not changed by old scenes', async () => {
  const state = defaultState(), c = new Controller(state, {});
  await c.command({ type: 'profile', name: 'My fixture', channels: [{ kind: 'dimmer', label: 'Intensity', value: 0 }] });
  assert.equal(c.view().library.at(-1).name, 'My fixture');
  await c.command({ type: 'saveScene', name: 'My look', fade: 0 });
  const scene = state.scenes.at(-1);
  const patch = structuredClone(state.fixtures); patch[0].id = 'new-light'; patch[0].levels.intensity = 17;
  await c.command({ type: 'patch', fixtures: patch });
  await c.command({ type: 'recallScene', id: scene.id });
  assert.equal(state.fixtures[0].levels.intensity, 17);
});

test('output configuration validates networking, protocols and numeric ranges', () => {
  const config = defaultState().adapters[0].config;
  assert.equal(validateOutput(config).olaUrl, 'http://127.0.0.1:9090');
  for (const patch of [{ universe: 0 }, { priority: 201 }, { destination: 'example.com' }, { interface: 'bad' }, { olaUrl: 'file:///tmp/file' }, { mode: 'raw' }]) assert.throws(() => validateOutput({ ...config, ...patch }));
  assert.equal(multicastAddress(1), '239.255.0.1'); assert.equal(multicastAddress(63999), '239.255.249.255');
});

test('sACN packet carries correct layer lengths, identifiers, sequence, CID and all slots', () => {
  const state = defaultState(), slots = Buffer.alloc(512); slots[0] = 123; slots[511] = 231;
  const packet = sacnPacket({ cid: state.cid, universe: 300, priority: 120, sequence: 258 }, slots);
  assert.equal(packet.length, 638); assert.equal(packet.readUInt16BE(0), 16);
  assert.equal(packet.toString('ascii', 4, 16), 'ASC-E1.17\0\0\0');
  assert.equal(packet.readUInt16BE(16), 0x726e); assert.equal(packet.readUInt32BE(18), 4);
  assert.equal(packet.subarray(22, 38).toString('hex'), state.cid.replaceAll('-', ''));
  assert.equal(packet.readUInt16BE(38), 0x7258); assert.equal(packet.readUInt32BE(40), 2);
  assert.equal(packet[108], 120); assert.equal(packet[111], 2); assert.equal(packet[112], 0);
  assert.equal(packet.readUInt16BE(113), 300); assert.equal(packet.readUInt16BE(115), 0x720b);
  assert.equal(packet[117], 2); assert.equal(packet[118], 0xa1);
  assert.equal(packet.readUInt16BE(119), 0); assert.equal(packet.readUInt16BE(121), 1);
  assert.equal(packet.readUInt16BE(123), 513); assert.equal(packet[125], 0);
  assert.equal(packet[126], 123); assert.equal(packet[637], 231);
  assert.equal(sacnPacket({ cid: state.cid, universe: 1, terminated: true }, slots)[112], 0x40);
});
