import { randomUUID } from 'node:crypto';
import { BUILTIN_PROFILES, validatePatch, validateChannels, percent, name } from './fixtures.js';
import { validateAdapters } from './adapters.js';

export class Controller {
  constructor(state, output, onChange = () => {}) {
    this.state = state;
    this.output = output;
    this.onChange = onChange;
    this.fade = null;
  }
  view() {
    const adapters = this.state.adapters.map(a => {
      const { mqttPassword, ...config } = a.config;
      return { ...a, config: { ...config, mqttPasswordSet: !!mqttPassword } };
    });
    return { ...this.state, adapters, library: [...BUILTIN_PROFILES, ...this.state.profiles], status: this.output.status, adapterStatuses: this.output.statuses, fading: !!this.fade };
  }
  changed() { this.onChange(); }
  cancelFade() { this.fade = null; this.state.activeScene = null; }
  async command(message) {
    const s = this.state;
    switch (message.type) {
      case 'master':
        s.master = percent(message.value); this.output.touch?.(s.fixtures.filter(f => f.followDesk).map(f => f.id)); this.cancelFade(); break;
      case 'blackout':
        if (typeof message.value !== 'boolean') throw new Error('Blackout must be on or off.');
        s.blackout = message.value; this.output.touch?.(s.fixtures.filter(f => f.followDesk).map(f => f.id)); break;
      case 'levels': {
        if (!Array.isArray(message.ids) || !message.ids.length) throw new Error('Select a fixture.');
        const fixtures = message.ids.map(id => { const f = s.fixtures.find(f => f.id === id); if (!f) throw new Error('Fixture not found.'); return f; });
        if (!message.levels || typeof message.levels !== 'object') throw new Error('Levels are required.');
        const changes = Object.fromEntries(Object.entries(message.levels).map(([k, v]) => {
          if (!['intensity', 'red', 'green', 'blue', 'white', 'amber', 'uv'].includes(k)) throw new Error('Unknown level.');
          return [k, percent(v)];
        }));
        fixtures.forEach(f => Object.assign(f.levels, changes)); this.output.touch?.(message.ids); this.cancelFade(); break;
      }
      case 'position': {
        const f = s.fixtures.find(f => f.id === message.id);
        if (!f) throw new Error('Fixture not found.');
        const x = percent(message.x), y = percent(message.y);
        Object.assign(f, { x, y }); break;
      }
      case 'patch': {
        const patch = validatePatch(message.fixtures, s.adapters);
        // Retain live levels and positions when only editing the patch.
        for (const f of patch) {
          const old = s.fixtures.find(old => old.id === f.id);
          if (old) { f.levels = old.levels; f.x = old.x; f.y = old.y; }
        }
        s.fixtures = patch; this.cancelFade(); break;
      }
      case 'profile': {
        if (s.profiles.length >= 64) throw new Error('Maximum 64 custom profiles.');
        const profile = { id: randomUUID(), name: name(message.name, 'Profile name'), channels: validateChannels(message.channels) };
        if ([...BUILTIN_PROFILES, ...s.profiles].some(p => p.name.toLowerCase() === profile.name.toLowerCase())) throw new Error('A profile with this name already exists.');
        s.profiles.push(profile); break;
      }
      case 'saveScene': {
        if (s.scenes.length >= 32) throw new Error('Maximum 32 scenes.');
        const scene = { id: randomUUID(), name: name(message.name, 'Scene name'), fade: percent(message.fade, 'Fade duration'), master: s.master, fixtures: Object.fromEntries(s.fixtures.map(f => [f.id, { ...f.levels }])) };
        s.scenes.push(scene); s.activeScene = scene.id; break;
      }
      case 'deleteScene':
        s.scenes = s.scenes.filter(scene => scene.id !== message.id);
        if (s.activeScene === message.id) this.cancelFade(); break;
      case 'recallScene': {
        const scene = s.scenes.find(scene => scene.id === message.id);
        if (!scene) throw new Error('Scene not found.');
        s.activeScene = scene.id;
        this.fade = { start: performance.now(), duration: scene.fade * 1000, master: s.master,
          from: Object.fromEntries(s.fixtures.map(f => [f.id, { ...f.levels }])), target: scene };
        this.output.touch?.(Object.keys(scene.fixtures));
        this.tick(); break;
      }
      case 'output': {
        const adapter = s.adapters.find(a => a.id === message.adapterId);
        if (!adapter) throw new Error('Output adapter not found.');
        if ((adapter.config.mode === 'mqtt') !== (message.config?.mode === 'mqtt') && s.fixtures.some(f => f.adapterId === adapter.id)) throw new Error('Reassign this adapter’s fixtures before changing between Zigbee2MQTT and DMX output.');
        const config = { ...message.config, mqttPassword: message.config?.mqttPassword ?? adapter.config.mqttPassword };
        const adapters = validateAdapters(s.adapters.map(a => a.id === adapter.id ? { ...a, name: message.name, config } : a));
        const fixtures = validatePatch(s.fixtures, adapters);
        await this.output.disconnect(adapter.id);
        s.adapters = adapters; s.fixtures = fixtures;
        this.output.configure(adapters.find(a => a.id === adapter.id)); break;
      }
      case 'addAdapter': {
        const adapter = { id: randomUUID(), name: message.name, config: message.config };
        const adapters = validateAdapters([...s.adapters, adapter]);
        this.output.add(adapter); s.adapters = adapters; break;
      }
      case 'removeAdapter': {
        if (s.adapters.length === 1) throw new Error('Keep at least one output adapter.');
        if (!s.adapters.some(a => a.id === message.adapterId)) throw new Error('Output adapter not found.');
        if (s.fixtures.some(f => f.adapterId === message.adapterId)) throw new Error('Reassign this adapter’s fixtures in Fixture patch before removing it.');
        await this.output.remove(message.adapterId); s.adapters = s.adapters.filter(a => a.id !== message.adapterId); break;
      }
      case 'connect':
        if (!s.adapters.some(a => a.id === message.adapterId)) throw new Error('Output adapter not found.');
        // Start from blackout across every adapter, regardless of stored levels.
        if (s.adapters.find(a => a.id === message.adapterId).config.mode !== 'mqtt') s.blackout = true;
        this.changed();
        await this.output.connect(message.adapterId); break;
      case 'disconnect':
        await this.output.disconnect(message.adapterId); break;
      default: throw new Error('Unknown command.');
    }
    this.changed();
  }
  tick(now = performance.now()) {
    if (!this.fade) return false;
    const { start, duration, master, from, target } = this.fade;
    const t = duration ? Math.min(1, Math.max(0, (now - start) / duration)) : 1;
    this.state.master = master + (target.master - master) * t;
    for (const f of this.state.fixtures) {
      if (!target.fixtures[f.id]) continue;
      for (const k of Object.keys(f.levels)) f.levels[k] = from[f.id][k] + (target.fixtures[f.id][k] - from[f.id][k]) * t;
    }
    if (t >= 1) { this.fade = null; this.changed(); }
    return true;
  }
}
