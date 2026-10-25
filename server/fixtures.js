import { randomUUID } from 'node:crypto';
import { mqttTopic } from './mqtt.js';

export const KINDS = ['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'fixed'];
const channel = (kind, label = kind, value = 0) => ({ kind, label, value });
const rgb = () => ['red', 'green', 'blue'].map(k => channel(k));
export const BUILTIN_PROFILES = [
  { id: 'dimmer-1', name: 'Dimmer · 1 channel', channels: [channel('dimmer')] },
  { id: 'rgb-3', name: 'RGB · 3 channels', channels: rgb() },
  { id: 'rgbw-4', name: 'RGBW · 4 channels', channels: [...rgb(), channel('white')] },
  { id: 'drgb-4', name: 'Dimmer + RGB · 4 channels', channels: [channel('dimmer'), ...rgb()] },
  { id: 'drgbw-5', name: 'Dimmer + RGBW · 5 channels', channels: [channel('dimmer'), ...rgb(), channel('white')] },
  { id: 'rgbwauv-6', name: 'RGBWAUV · 6 channels', channels: [...rgb(), ...['white', 'amber', 'uv'].map(k => channel(k))] },
  { id: 'slimpar56-7', name: 'Chauvet SlimPAR 56 · 7 channels', note: '7-CH mode: RGB, macro, strobe, mode, dimmer. Verify your model and mode.', channels: [...rgb(), channel('fixed', 'Color macro'), channel('fixed', 'Strobe'), channel('fixed', 'Mode'), channel('dimmer')] },
];

export function percent(v, name = 'Level') {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${name} must be between 0 and 100.`);
  return v;
}
export function integer(v, min, max, name) {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be ${min}–${max}.`);
  return v;
}
export function name(v, fallback = '') {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 64) throw new Error(`${fallback || 'Name'} must contain 1–64 characters.`);
  return v.trim();
}
export function validateChannels(channels) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 512) throw new Error('A profile needs 1–512 channels.');
  return channels.map(c => {
    if (!c || !KINDS.includes(c.kind)) throw new Error('Unknown channel type.');
    return { kind: c.kind, label: name(c.label, 'Channel name'), value: integer(c.value ?? 0, 0, 255, 'Fixed value') };
  });
}
export function validateLevels(levels) {
  if (!levels || typeof levels !== 'object') throw new Error('Fixture levels are required.');
  return Object.fromEntries(['intensity', 'red', 'green', 'blue', 'white', 'amber', 'uv'].map(k => [k, percent(levels[k] ?? (k === 'intensity' ? 100 : 0), k)]));
}
export function validatePatch(fixtures, adapters) {
  if (!Array.isArray(fixtures) || fixtures.length > 32) throw new Error('Use up to 32 fixtures.');
  const used = new Set(), ids = new Set();
  return fixtures.map(f => {
    if (typeof f.id !== 'string' || !f.id || f.id.length > 64 || ids.has(f.id)) throw new Error('Fixture IDs must be unique.');
    ids.add(f.id);
    const adapterId = f.adapterId;
    if (typeof adapterId !== 'string' || !adapterId || (adapters && !adapters.some(a => a.id === adapterId))) throw new Error('Assign each fixture to an existing output adapter.');
    const mqtt = adapters?.find(a => a.id === adapterId)?.config.mode === 'mqtt';
    const channels = mqtt ? [channel('dimmer')] : validateChannels(f.channels);
    const address = mqtt ? 1 : integer(f.address, 1, 513 - channels.length, 'Start address');
    let mqttFields = {};
    if (mqtt) {
      const mqttDevice = mqttTopic(f.mqttDevice, 'Zigbee2MQTT device name');
      if (mqttDevice === 'bridge' || mqttDevice.startsWith('bridge/')) throw new Error('Choose a device or group, not a Zigbee2MQTT bridge topic.');
      if (used.has(`${adapterId}:device:${mqttDevice}`)) throw new Error('This Zigbee2MQTT device is already assigned to another fixture.');
      used.add(`${adapterId}:device:${mqttDevice}`);
      if (f.followDesk !== undefined && typeof f.followDesk !== 'boolean') throw new Error('Follow master/blackout must be on or off.');
      mqttFields = { mqttDevice, mqttMaxBrightness: integer(f.mqttMaxBrightness ?? 254, 1, 255, 'Maximum brightness'), followDesk: f.followDesk === true };
    }
    for (let i = address; i < address + channels.length; i++) {
      if (mqtt) continue;
      const key = `${adapterId}:${i}`;
      if (used.has(key)) throw new Error(`Channel ${i} overlaps another fixture on this adapter.`);
      used.add(key);
    }
    return { id: f.id, adapterId, name: name(f.name, 'Fixture name'), profileName: mqtt ? 'Zigbee2MQTT dimmer' : name(f.profileName, 'Profile name'), channels, address, ...mqttFields,
      x: percent(f.x, 'Horizontal position'), y: percent(f.y, 'Vertical position'), levels: validateLevels(f.levels) };
  });
}
export function renderDmx(state, adapterId = state.adapters?.[0]?.id) {
  const slots = Buffer.alloc(512);
  if (state.blackout) return slots;
  for (const f of state.fixtures) {
    if (adapterId && f.adapterId !== adapterId) continue;
    const hasDimmer = f.channels.some(c => c.kind === 'dimmer');
    const gain = f.levels.intensity / 100 * state.master / 100;
    f.channels.forEach((c, i) => {
      const value = c.kind === 'fixed' ? c.value : c.kind === 'dimmer' ? gain * 255 : f.levels[c.kind] / 100 * 255 * (hasDimmer ? 1 : gain);
      slots[f.address - 1 + i] = Math.round(value);
    });
  }
  return slots;
}
export function defaultState() {
  const fixtures = ['Left wash', 'Right wash'].map((name, i) => ({ id: `wash-${i + 1}`, adapterId: 'main', name, profileName: BUILTIN_PROFILES[1].name, channels: rgb(), address: 1 + i * 3, x: 28 + i * 44, y: 48,
    levels: { intensity: 75, red: i ? 34 : 100, green: i ? 45 : 49, blue: i ? 100 : 22, white: 0, amber: 0, uv: 0 } }));
  const scenes = [
    ['warm', 'Golden hour', [100, 49, 22], [100, 67, 35]],
    ['blue', 'Blue hour', [24, 43, 100], [49, 27, 100]],
    ['pink', 'Afterglow', [100, 22, 49], [66, 28, 100]],
    ['white', 'Work lights', [100, 100, 100], [100, 100, 100]],
  ].map(([id, name, a, b]) => ({ id, name, fade: 1, master: 80, fixtures: Object.fromEntries(fixtures.map((f, i) => [f.id, { ...f.levels, intensity: 75, red: (i ? b : a)[0], green: (i ? b : a)[1], blue: (i ? b : a)[2] }])) }));
  return { version: 2, cid: randomUUID(), master: 80, blackout: false, fixtures, profiles: [], scenes, activeScene: null,
    adapters: [{ id: 'main', name: 'Main output', config: { mode: 'preview', universe: 1, artnetUniverse: 0, priority: 100, destination: '', interface: '', olaUrl: 'http://127.0.0.1:9090', olaUniverse: 1,
      mqttUrl: 'mqtt://127.0.0.1:1883', mqttBaseTopic: 'zigbee2mqtt', mqttUsername: '', mqttPassword: '' } }] };
}

export function migrateState(state) {
  if (state.version === 1) {
    state.adapters = [{ id: 'main', name: 'Main output', config: state.output }];
    state.fixtures = state.fixtures.map(f => ({ ...f, adapterId: 'main' }));
    delete state.output;
    state.version = 2;
  }
  return state;
}
