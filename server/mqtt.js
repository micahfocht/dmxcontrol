import { connect } from 'mqtt';

export function mqttTopic(value, label) {
  const topic = typeof value === 'string' ? value.trim() : '';
  if (!topic || topic.length > 128 || /[+#\x00-\x1f]/.test(topic) || topic.startsWith('/') || topic.endsWith('/')) throw new Error(`${label} must be a topic name without wildcards or leading/trailing slashes.`);
  return topic;
}

export function dimmerCommand(fixture, state) {
  const follow = fixture.followDesk === true;
  const intensity = follow && state.blackout ? 0 : fixture.levels.intensity * (follow ? state.master / 100 : 1);
  const brightness = Math.round(intensity / 100 * fixture.mqttMaxBrightness);
  return brightness ? { state: 'ON', brightness } : { state: 'OFF' };
}

// Unlike DMX, Zigbee sends changes rather than a continuous frame stream.
export class MqttOutput {
  constructor(state, adapterId, cid, onStatus = () => {}, onChange = () => {}, isFading = () => false) {
    Object.assign(this, { state, adapterId, cid, onStatus, onChange, isFading });
    this.status = { connected: false, connecting: false, error: null, frames: 0, bridgeOnline: null, devices: [], reported: Object.create(null) };
    this.baselines = new Map(); this.lastSent = new Map(); this.topicSignature = ''; this.subscriptions = new Set();
    this.nextPublish = 0; this.pending = null; this.client = null; this.subscriptionPending = null; this.cursor = 0;
  }
  fixtures() { return this.state.fixtures.filter(f => f.adapterId === this.adapterId); }
  report(patch) { Object.assign(this.status, patch); this.onStatus(); }
  remember(f) { this.baselines.set(f.id, { device: f.mqttDevice, command: JSON.stringify(dimmerCommand(f, this.state)) }); }
  request(f) { this.baselines.set(f.id, { device: f.mqttDevice, command: null }); }
  resetBaselines() { this.baselines.clear(); this.lastSent.clear(); this.fixtures().forEach(f => this.remember(f)); }
  async subscribeFixtures() {
    if (this.subscriptionPending) return this.subscriptionPending;
    this.subscriptionPending = this.updateSubscriptions();
    try { await this.subscriptionPending; } finally { this.subscriptionPending = null; }
  }
  async updateSubscriptions() {
    if (!this.client?.connected) return;
    const base = this.config.mqttBaseTopic;
    const desired = new Set([`${base}/bridge/state`, `${base}/bridge/devices`, ...this.fixtures().flatMap(f => [`${base}/${f.mqttDevice}`, `${base}/${f.mqttDevice}/availability`])]);
    const signature = [...desired].sort().join('\n');
    if (signature === this.topicSignature) return;
    const removed = [...this.subscriptions].filter(topic => !desired.has(topic));
    if (removed.length) await this.client.unsubscribeAsync(removed);
    const added = [...desired].filter(topic => !this.subscriptions.has(topic));
    if (added.length) {
      const granted = await this.client.subscribeAsync(added, { qos: 0 });
      if (granted.some(g => g.qos === 128)) throw new Error('MQTT subscription denied. Check broker topic permissions.');
    }
    this.subscriptions = desired;
    this.topicSignature = signature;
  }
  async connect(config) {
    await this.disconnect();
    this.config = { ...config }; this.topicSignature = ''; this.subscriptions.clear();
    this.status.reported = Object.create(null); this.status.devices = []; this.status.bridgeOnline = null;
    this.resetBaselines(); this.report({ connecting: true, error: null, frames: 0 });
    const client = connect(config.mqttUrl, { clientId: `dmx-${this.cid}`, username: config.mqttUsername || undefined, password: config.mqttPassword || undefined,
      clean: true, queueQoSZero: false, reconnectPeriod: 2000, connectTimeout: 5000, keepalive: 30 });
    this.client = client;
    client.on('message', (topic, payload) => { if (this.client === client) this.message(topic, payload); });
    client.on('close', () => { if (this.client === client) { this.resetBaselines(); this.report({ connected: false, connecting: false }); } });
    client.on('reconnect', () => { if (this.client === client) this.report({ connecting: true }); });
    client.on('error', e => { if (this.client === client) this.report({ error: `MQTT: ${e.message}` }); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MQTT connection timed out. Check the broker address.')), 6000);
      const initialError = e => { clearTimeout(timeout); reject(e); };
      client.once('error', initialError);
      client.on('connect', async () => {
        this.resetBaselines(); this.topicSignature = ''; this.subscriptions.clear();
        try {
          await this.subscribeFixtures();
          if (this.client !== client) return;
          this.report({ connected: true, connecting: false, error: this.status.bridgeOnline === false ? 'Zigbee2MQTT is offline.' : null });
          clearTimeout(timeout); client.removeListener('error', initialError); resolve();
        } catch (e) { this.report({ connected: false, connecting: false, error: e.message }); clearTimeout(timeout); reject(e); }
      });
    }).catch(async e => {
      await this.disconnect(); this.report({ error: `Cannot connect to MQTT: ${e.message}` }); throw new Error(this.status.error);
    });
  }
  message(topic, payload) {
    if (payload.length > 1024 * 1024) return;
    let data; try { data = JSON.parse(payload.toString()); } catch { data = payload.toString(); }
    const base = this.config.mqttBaseTopic;
    if (topic === `${base}/bridge/state`) {
      const online = (typeof data === 'string' ? data : data?.state) === 'online';
      this.report({ bridgeOnline: online, error: online ? null : 'Zigbee2MQTT is offline.' });
      return;
    }
    if (topic === `${base}/bridge/devices` && Array.isArray(data)) {
      const brightness = exposes => {
        if (!Array.isArray(exposes)) return null;
        for (const expose of exposes) {
          if (expose?.property === 'brightness' && (expose.access & 2)) return expose;
          const child = brightness(expose?.features); if (child) return child;
        }
        return null;
      };
      const devices = [];
      for (const d of data) {
        const b = brightness(d?.definition?.exposes);
        if (b && d.friendly_name && devices.length < 256) devices.push({ name: String(d.friendly_name).slice(0, 128), maxBrightness: b.value_max || 254 });
      }
      this.report({ devices }); return;
    }
    for (const f of this.fixtures()) {
      const target = `${base}/${f.mqttDevice}`;
      if (topic === `${target}/availability`) {
        const availability = typeof data === 'string' ? data : data?.state;
        if (['online', 'offline'].includes(availability)) {
          if (this.status.reported[f.id]?.available !== (availability === 'online')) this.remember(f);
          this.status.reported[f.id] = { ...this.status.reported[f.id], available: availability === 'online' };
          this.onStatus();
        }
      } else if (topic === target && data && typeof data === 'object') {
        const previous = this.status.reported[f.id] ?? {};
        const power = ['ON', 'OFF'].includes(data.state) ? data.state : previous.power;
        const brightness = typeof data.brightness === 'number' && Number.isFinite(data.brightness) ? Math.max(0, Math.min(f.mqttMaxBrightness, data.brightness)) : previous.brightness;
        const level = power === 'OFF' ? 0 : brightness === undefined ? undefined : brightness / f.mqttMaxBrightness * 100;
        this.status.reported[f.id] = { ...previous, power, brightness, level, receivedAt: Date.now() };
        // Ignore transitional echoes immediately after our own changes. External
        // updates adopt the reported level without issuing another command.
        if (level !== undefined && Date.now() - (this.lastSent.get(f.id) ?? 0) > 1500 && !this.isFading() && !(f.followDesk && (this.state.blackout || this.state.master === 0))) {
          const intensity = Math.min(100, level / (f.followDesk ? this.state.master / 100 : 1));
          if (Math.abs(f.levels.intensity - intensity) > 0.01) {
            f.levels.intensity = intensity; this.state.activeScene = null; this.remember(f); this.onChange();
          }
        }
        this.onStatus();
      }
    }
  }
  send() {
    const fixtures = this.fixtures(), ids = new Set(fixtures.map(f => f.id));
    for (const id of this.baselines.keys()) if (!ids.has(id)) { this.baselines.delete(id); delete this.status.reported[id]; this.lastSent.delete(id); }
    for (const f of fixtures) if (this.baselines.get(f.id)?.device !== f.mqttDevice) this.remember(f);
    if (!this.status.connected || !this.client?.connected || this.status.bridgeOnline === false) { fixtures.forEach(f => this.remember(f)); return; }
    this.subscribeFixtures().catch(e => this.report({ error: e.message }));
    if (this.pending || Date.now() < this.nextPublish) return;
    for (let i = 0; i < fixtures.length; i++) {
      const index = (this.cursor + i) % fixtures.length, f = fixtures[index];
      if (this.status.reported[f.id]?.available === false) { this.remember(f); continue; }
      const command = JSON.stringify(dimmerCommand(f, this.state));
      if (command === this.baselines.get(f.id).command || Date.now() - (this.lastSent.get(f.id) ?? 0) < 200) continue;
      this.remember(f); this.lastSent.set(f.id, Date.now()); this.nextPublish = Date.now() + 100;
      this.cursor = (index + 1) % fixtures.length;
      this.pending = this.client.publishAsync(`${this.config.mqttBaseTopic}/${f.mqttDevice}/set`, command, { qos: 0, retain: false })
        .then(() => { this.status.frames++; this.onStatus(); })
        .catch(e => this.report({ error: `MQTT publish failed: ${e.message}` }))
        .finally(() => { this.pending = null; });
      return;
    }
  }
  async disconnect() {
    const client = this.client; this.client = null;
    // Disconnecting this controller leaves house lights at their last level.
    this.report({ connected: false, connecting: false });
    await this.pending;
    if (client) await client.endAsync(true);
    this.report({ connected: false, connecting: false, error: null });
  }
}
