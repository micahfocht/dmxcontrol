import { createHash } from 'node:crypto';
import { Output, validateOutput } from './output.js';
import { name, renderDmx } from './fixtures.js';
import { MqttOutput } from './mqtt.js';

export function validateAdapters(adapters) {
  if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 32) throw new Error('Use 1–32 output adapters.');
  const ids = new Set(), routes = new Set();
  return adapters.map(a => {
    if (typeof a.id !== 'string' || !a.id || a.id.length > 64 || ids.has(a.id)) throw new Error('Adapter IDs must be unique.');
    ids.add(a.id);
    const config = validateOutput(a.config);
    // Two identical destinations/universes would compete for the same receiver.
    const route = config.mode === 'sacn' ? `sacn:${config.destination || 'multicast'}:${config.universe}` : config.mode === 'artnet' ? `artnet:${config.destination}:${config.artnetUniverse}` : config.mode === 'usb' ? `usb:${config.olaUrl}:${config.olaUniverse}` : config.mode === 'mqtt' ? `mqtt:${config.mqttUrl}:${config.mqttBaseTopic}` : null;
    if (route && routes.has(route)) throw new Error('Another adapter already uses this destination and universe. Share that adapter or choose another universe.');
    if (route) routes.add(route);
    return { id: a.id, name: name(a.name, 'Adapter name'), config };
  });
}

function adapterCid(cid, id) {
  const bytes = createHash('sha256').update(`${cid}:${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class Adapters {
  constructor(state, onStatus = () => {}, onChange = () => {}, isFading = () => false) {
    this.state = state;
    this.onStatus = onStatus;
    this.onChange = onChange; this.isFading = isFading;
    this.outputs = new Map();
    for (const a of state.adapters) this.add(a);
  }
  add(adapter) {
    const cid = adapterCid(this.state.cid, adapter.id);
    this.outputs.set(adapter.id, adapter.config.mode === 'mqtt' ? new MqttOutput(this.state, adapter.id, cid, this.onStatus, this.onChange, this.isFading) : new Output(cid, this.onStatus));
  }
  configure(adapter) {
    if ((this.get(adapter.id) instanceof MqttOutput) !== (adapter.config.mode === 'mqtt')) this.add(adapter);
  }
  get(id) { const output = this.outputs.get(id); if (!output) throw new Error('Output adapter not found.'); return output; }
  get statuses() { return Object.fromEntries([...this.outputs].map(([id, output]) => [id, output.status])); }
  get status() {
    const values = [...this.outputs.values()].map(o => o.status);
    const errors = this.state.adapters.filter(a => this.outputs.get(a.id)?.status.error).map(a => `${a.name}: ${this.outputs.get(a.id).status.error}`);
    return { connected: values.some(s => s.connected), connectedCount: values.filter(s => s.connected).length,
      connecting: values.some(s => s.connecting), error: errors.join(' · ') || null, frames: values.reduce((sum, s) => sum + s.frames, 0) };
  }
  async connect(id) {
    const adapter = this.state.adapters.find(a => a.id === id);
    if (!adapter) throw new Error('Output adapter not found.');
    await this.get(id).connect(adapter.config);
  }
  async disconnect(id) { await this.get(id).disconnect(); }
  async remove(id) { await this.disconnect(id); this.outputs.delete(id); }
  touch(ids) {
    const selected = new Set(ids);
    for (const f of this.state.fixtures) if (selected.has(f.id)) this.get(f.adapterId).request?.(f);
  }
  send() { for (const a of this.state.adapters) this.get(a.id).send(a.config.mode === 'mqtt' ? undefined : renderDmx(this.state, a.id)); }
  async disconnectAll() {
    const results = await Promise.allSettled([...this.outputs.values()].map(output => output.disconnect()));
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    if (errors.length) throw new Error(errors.join(' · '));
  }
}
