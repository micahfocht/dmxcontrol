import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, migrateState, renderDmx, validatePatch } from '../server/fixtures.js';
import { Adapters, validateAdapters } from '../server/adapters.js';
import { Controller } from '../server/controller.js';

test('fixtures at the same address on separate adapters have isolated universe buffers', () => {
  const state = defaultState();
  state.adapters.push({ id: 'second', name: 'Right node', config: { ...state.adapters[0].config, universe: 2 } });
  state.fixtures[1].adapterId = 'second'; state.fixtures[1].address = 1;
  assert.doesNotThrow(() => validatePatch(state.fixtures, state.adapters));
  state.master = 100; state.fixtures[0].levels.intensity = state.fixtures[1].levels.intensity = 100;
  state.fixtures[0].levels = { ...state.fixtures[0].levels, red: 100, green: 0, blue: 0 };
  state.fixtures[1].levels = { ...state.fixtures[1].levels, red: 0, green: 0, blue: 100 };
  assert.deepEqual([...renderDmx(state, 'main').subarray(0, 6)], [255, 0, 0, 0, 0, 0]);
  assert.deepEqual([...renderDmx(state, 'second').subarray(0, 6)], [0, 0, 255, 0, 0, 0]);
  state.blackout = true;
  assert.ok(renderDmx(state, 'main').every(v => v === 0)); assert.ok(renderDmx(state, 'second').every(v => v === 0));
  state.fixtures[1].adapterId = 'missing'; assert.throws(() => validatePatch(state.fixtures, state.adapters), /existing output adapter/);
});

test('adapter routes may reuse a universe at different IPs, but identical destination/universe pairs are rejected', () => {
  const state = defaultState(), config = { ...state.adapters[0].config, mode: 'sacn', universe: 1, destination: '192.168.1.20' };
  const adapters = [{ id: 'a', name: 'A', config }, { id: 'b', name: 'B', config: { ...config, destination: '192.168.1.21' } }];
  assert.doesNotThrow(() => validateAdapters(adapters));
  assert.throws(() => validateAdapters([...adapters, { id: 'c', name: 'C', config }]), /already uses/);
  adapters[1].config = { ...config, universe: 2 };
  assert.doesNotThrow(() => validateAdapters(adapters));
  const usb = { ...config, mode: 'usb' };
  assert.throws(() => validateAdapters([{ id: 'a', name: 'A', config: usb }, { id: 'b', name: 'B', config: usb }]), /already uses/);
});

test('each adapter has a stable distinct sACN source ID', () => {
  const state = defaultState(); state.adapters.push({ ...state.adapters[0], id: 'second', name: 'Second' });
  const a = new Adapters(state), b = new Adapters(structuredClone(state));
  assert.notEqual(a.get('main').cid, a.get('second').cid); assert.equal(a.get('main').cid, b.get('main').cid);
});

test('adapters cannot be removed while assigned and configuring one leaves others alone', async () => {
  const state = defaultState(), outputs = new Adapters(state), c = new Controller(state, outputs);
  await c.command({ type: 'addAdapter', name: 'New node', config: { ...state.adapters[0].config, mode: 'sacn', universe: 2 } });
  const id = state.adapters.at(-1).id;
  const patch = structuredClone(state.fixtures); patch[1].adapterId = id; patch[1].address = 1;
  await c.command({ type: 'patch', fixtures: patch });
  await assert.rejects(c.command({ type: 'removeAdapter', adapterId: id }), /Reassign/);
  const untouched = structuredClone(state.adapters[0]);
  await c.command({ type: 'output', adapterId: id, name: 'Right light', config: { ...state.adapters[1].config, universe: 10, destination: '127.0.0.1' } });
  assert.deepEqual(state.adapters[0], untouched);
  await c.command({ type: 'patch', fixtures: [state.fixtures[0]] });
  await c.command({ type: 'removeAdapter', adapterId: id }); assert.equal(state.adapters.length, 1);
  await assert.rejects(c.command({ type: 'removeAdapter', adapterId: 'main' }), /at least one/);
});

test('legacy single-universe state migrates without changing patch, layout, levels or scenes', () => {
  const original = defaultState(), legacy = structuredClone(original);
  legacy.version = 1; legacy.output = legacy.adapters[0].config; delete legacy.adapters;
  legacy.fixtures.forEach(f => delete f.adapterId);
  assert.deepEqual(migrateState(legacy), original);
});
