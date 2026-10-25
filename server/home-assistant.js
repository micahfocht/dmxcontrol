// Saved scenes are momentary buttons. Discovery is retained; presses never are.
export class HomeAssistantScenes {
  constructor(output, onCommand, isHost) {
    Object.assign(this, { output, onCommand, isHost });
    this.deviceId = `dmxcontrol_${output.state.cid}`;
    this.discoveryPrefix = `homeassistant/button/${this.deviceId}/`;
    this.commandTopic = `dmxcontrol/${output.state.cid}/scene/recall`;
    this.availabilityTopic = `dmxcontrol/${output.state.cid}/${output.cid}/availability`;
    this.published = new Map();
    this.refresh = true;
    this.pending = null;
    this.retryAt = 0;
  }
  get subscriptions() { return ['homeassistant/status', `${this.discoveryPrefix}+/config`, this.commandTopic]; }
  get will() { return { topic: this.availabilityTopic, payload: 'offline', qos: 0, retain: true }; }
  configs() {
    return new Map(this.output.state.scenes.map(scene => {
      const key = Buffer.from(scene.id).toString('hex');
      return [`${this.discoveryPrefix}${key}/config`, JSON.stringify({
        name: scene.name, unique_id: `${this.deviceId}_${key}`, icon: 'mdi:palette',
        command_topic: this.commandTopic, payload_press: scene.id, qos: 0, retain: false,
        availability_topic: this.availabilityTopic,
        device: { identifiers: [this.deviceId], name: 'DMX Control', manufacturer: 'DMX Control', model: 'Lighting controller' },
        origin: { name: 'DMX Control' },
      })];
    }));
  }
  message(topic, payload, packet) {
    if (topic === 'homeassistant/status') {
      if (payload.toString() === 'online') this.refresh = true;
      return true;
    }
    if (topic.startsWith(this.discoveryPrefix) && topic.endsWith('/config')) {
      // Read our retained discovery too, so scenes deleted while disconnected
      // (including across a process restart) are removed on the next connection.
      if (payload.length) this.published.set(topic, payload.toString());
      else this.published.delete(topic);
      return true;
    }
    if (topic !== this.commandTopic) return false;
    const id = payload.toString();
    if (!packet?.retain && this.output.status.connected && this.isHost() && this.output.state.scenes.some(scene => scene.id === id)) {
      Promise.resolve().then(() => this.onCommand({ type: 'recallScene', id }))
        .catch(e => this.output.report({ error: `Home Assistant: ${e.message}` }));
    }
    return true;
  }
  sync() {
    const { client, status } = this.output;
    if (!client?.connected || !status.connected || !this.isHost()) { this.refresh = true; return; }
    if (this.pending || Date.now() < this.retryAt) return this.pending;
    const desired = this.configs();
    const updates = [...this.published.keys()].filter(topic => !desired.has(topic)).map(topic => [topic, '']);
    for (const [topic, payload] of desired) if (this.refresh || this.published.get(topic) !== payload) updates.push([topic, payload]);
    this.refresh = false;
    if (!updates.length) return;
    this.pending = (async () => {
      for (const [topic, payload] of updates) {
        if (this.output.client !== client || !client.connected || !this.isHost()) { this.refresh = true; return; }
        await client.publishAsync(topic, payload, { qos: 0, retain: true });
        if (payload) this.published.set(topic, payload);
        else this.published.delete(topic);
      }
    })().catch(e => {
      this.refresh = true; this.retryAt = Date.now() + 2000;
      this.output.report({ error: `Home Assistant: ${e.message}` });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
