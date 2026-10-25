import dgram from 'node:dgram';
import { isIP } from 'node:net';
import { integer } from './fixtures.js';
import { multicastAddress, sacnPacket, artnetPacket } from './protocol.js';
import { mqttTopic } from './mqtt.js';

export function validateOutput(value) {
  if (!value || !['preview', 'sacn', 'artnet', 'usb', 'mqtt'].includes(value.mode)) throw new Error('Choose preview, sACN, Art-Net, USB, or Zigbee2MQTT.');
  const universe = integer(value.universe, 1, 63999, 'sACN universe');
  const artnetUniverse = integer(value.artnetUniverse ?? 0, 0, 32767, 'Art-Net port-address');
  const priority = integer(value.priority, 0, 200, 'sACN priority');
  const destination = String(value.destination ?? '').trim();
  const iface = String(value.interface ?? '').trim();
  if (destination && isIP(destination) !== 4) throw new Error('Enter an IPv4 destination, or leave blank for multicast.');
  if (value.mode === 'artnet' && (!destination || Number(destination.split('.')[0]) === 0 || Number(destination.split('.')[0]) >= 224)) throw new Error('Art-Net requires a unicast node IPv4 address.');
  if (iface && isIP(iface) !== 4) throw new Error('Network interface must be a local IPv4 address.');
  let url;
  try { url = new URL(value.olaUrl); } catch { throw new Error('Enter a valid OLA URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('OLA URL must be an HTTP origin, such as http://127.0.0.1:9090.');
  let broker;
  try { broker = new URL(value.mqttUrl ?? 'mqtt://127.0.0.1:1883'); } catch { throw new Error('Enter a valid MQTT broker URL.'); }
  if (!['mqtt:', 'mqtts:'].includes(broker.protocol) || !broker.hostname || broker.username || broker.password || !['', '/'].includes(broker.pathname) || broker.search || broker.hash) throw new Error('Use mqtt://host:1883 or mqtts://host:8883; enter credentials in their separate fields.');
  integer(Number(broker.port || (broker.protocol === 'mqtts:' ? 8883 : 1883)), 1, 65535, 'MQTT port');
  const mqttUsername = value.mqttUsername ?? '', mqttPassword = value.mqttPassword ?? '';
  if (typeof mqttUsername !== 'string' || mqttUsername.length > 128 || typeof mqttPassword !== 'string' || mqttPassword.length > 512) throw new Error('MQTT credentials are too long or invalid.');
  return { mode: value.mode, universe, artnetUniverse, priority, destination, interface: iface, olaUrl: url.origin, olaUniverse: integer(value.olaUniverse, 0, 63999, 'OLA universe'),
    mqttUrl: `${broker.protocol}//${broker.hostname}:${broker.port || (broker.protocol === 'mqtts:' ? 8883 : 1883)}`, mqttBaseTopic: mqttTopic(value.mqttBaseTopic ?? 'zigbee2mqtt', 'MQTT base topic'), mqttUsername, mqttPassword };
}

export class Output {
  constructor(cid, onStatus = () => {}) {
    this.cid = cid;
    this.onStatus = onStatus;
    this.status = { connected: false, connecting: false, error: null, frames: 0 };
    this.sequence = 0;
    this.config = null;
    this.pending = null;
    this.retryAt = null;
  }
  report(patch) {
    Object.assign(this.status, patch);
    this.onStatus();
  }
  async olaSend(slots) {
    const res = await fetch(`${this.config.olaUrl}/set_dmx`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ u: String(this.config.olaUniverse), d: Array.from(slots).join(',') }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.text();
    // OLA's /set_dmx endpoint responds with plain "ok" on success.
    if (!res.ok || body.trim() !== 'ok') throw new Error(`OLA rejected DMX: ${body.slice(0, 180) || res.status}`);
  }
  async connect(config) {
    await this.disconnect();
    this.config = { ...config };
    this.report({ connecting: true, error: null, frames: 0 });
    try {
      if (config.mode === 'sacn' || config.mode === 'artnet') {
        // Art-Net uses port 6454 for both source and destination. Reuse lets
        // separate adapters send from the same controller/interface.
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: config.mode === 'artnet' });
        this.socket.on('error', e => this.report({ connected: false, error: e.message }));
        await new Promise((resolve, reject) => {
          this.socket.once('error', reject);
          this.socket.bind(config.mode === 'artnet' ? 6454 : 0, config.interface || '0.0.0.0', () => { this.socket.removeListener('error', reject); resolve(); });
        });
        if (config.mode === 'sacn') {
          this.socket.setMulticastTTL(1);
          if (config.interface) this.socket.setMulticastInterface(config.interface);
        }
      } else if (config.mode === 'usb') {
        await this.olaSend(Buffer.alloc(512));
      } else {
        throw new Error('Preview mode does not send DMX. Choose an output first.');
      }
      this.report({ connected: true, connecting: false, error: null });
    } catch (e) {
      if (this.socket) { this.socket.close(); this.socket = null; }
      this.report({ connected: false, connecting: false, error: config.mode === 'usb' ? `Cannot send to OLA. Check the service and universe patch. ${e.message}` : e.message });
      throw new Error(this.status.error);
    }
  }
  sendUdp(slots, terminated = false) {
    if (this.config.mode === 'artnet') {
      const packet = artnetPacket({ universe: this.config.artnetUniverse, sequence: this.sequence++ % 255 + 1 }, slots);
      return new Promise((resolve, reject) => this.socket.send(packet, 6454, this.config.destination, e => e ? reject(e) : resolve()));
    }
    const packet = sacnPacket({ ...this.config, cid: this.cid, sequence: this.sequence++, terminated }, slots);
    return new Promise((resolve, reject) => this.socket.send(packet, 5568, this.config.destination || multicastAddress(this.config.universe), e => e ? reject(e) : resolve()));
  }
  send(slots) {
    // The regular output tick retries OLA with current levels, never queued frames.
    if ((!this.status.connected && this.retryAt === null) || this.pending || (this.retryAt !== null && Date.now() < this.retryAt)) return;
    this.pending = (this.config.mode === 'usb' ? this.olaSend(slots) : this.sendUdp(slots))
      .then(() => {
        if (!this.status.connected && this.retryAt === null) return; // Disconnected while sending.
        this.status.frames++;
        this.retryAt = null;
        if (!this.status.connected) this.report({ connected: true, connecting: false, error: null });
      })
      .catch(e => {
        if (!this.status.connected && this.retryAt === null) return;
        const retry = this.config.mode === 'usb';
        if (retry) this.retryAt = Date.now() + 2000;
        this.report({ connected: false, connecting: retry, error: retry ? `Cannot send to OLA. Retrying automatically every 2 seconds. ${e.message}` : e.message });
      })
      .finally(() => { this.pending = null; });
  }
  async disconnect() {
    // An in-flight retry may have reached OLA, so follow it with a final blackout.
    const wasConnected = this.status.connected || (this.retryAt !== null && !!this.pending);
    this.retryAt = null;
    this.report({ connected: false, connecting: false });
    await this.pending;
    let failure;
    if (wasConnected) {
      try {
        if (this.config.mode === 'sacn' && this.socket) {
          await this.sendUdp(Buffer.alloc(512));
          for (let i = 0; i < 3; i++) await this.sendUdp(Buffer.alloc(512), true);
        } else if (this.config.mode === 'artnet' && this.socket) {
          await this.sendUdp(Buffer.alloc(512));
        } else if (this.config.mode === 'usb') await this.olaSend(Buffer.alloc(512));
      } catch (e) { failure = `Could not send final blackout: ${e.message}`; }
    }
    if (this.socket) { this.socket.close(); this.socket = null; }
    this.report({ error: failure ?? null });
    if (failure) throw new Error(failure);
  }
}
