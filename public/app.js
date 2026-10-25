const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const clone = value => JSON.parse(JSON.stringify(value));
const makeId = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const rgb = levels => '#' + ['red', 'green', 'blue'].map(k => Math.round(levels[k] * 2.55).toString(16).padStart(2, '0')).join('');
const fromHex = hex => Object.fromEntries(['red', 'green', 'blue'].map((k, i) => [k, parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 2.55]));
const pretty = n => String(n).padStart(3, '0');
const adapterUniverse = a => a.config.mode === 'usb' ? a.config.olaUniverse : a.config.mode === 'artnet' ? a.config.artnetUniverse ?? 0 : a.config.universe;
const adapterDescription = a => a.config.mode === 'preview' ? 'Preview' : a.config.mode === 'mqtt' ? 'Zigbee2MQTT' : `${a.config.mode === 'artnet' ? 'Art-Net' : 'U'} ${adapterUniverse(a)}`;
const isMqtt = f => state.adapters.find(a => a.id === f.adapterId)?.config.mode === 'mqtt';
const followsDesk = f => !isMqtt(f) || f.followDesk === true;
const colors = [['Warm', '#ff7d38'], ['White', '#ffffff'], ['Red', '#ff465c'], ['Violet', '#a26dff'], ['Blue', '#4d85ff'], ['Mint', '#63dbaa']];
let state, ws, online = false, selected = new Set(), arranging = false, editingScenes = false, drag = null, outputId = 'main';
let stageSignature = '', inspectorSignature = '', sceneSignature = '', patchDraft = [], profileDraft = [], profileTarget = null;
let toastTimer, reconnectTimer, lastReceived = 0;
const pending = new Map(), touching = new Set(), throttleTimers = new Map(), throttleValues = new Map();

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function send(message) {
  if (!online || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Controller disconnected. Waiting to reconnect…'));
  const requestId = makeId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Controller did not respond. Check the connection.')); }, 8000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...message, requestId }));
  });
}
function act(message) { send(message).catch(e => toast(e.message)); }
function throttle(key, message, immediate = false) {
  throttleValues.set(key, message);
  const flush = () => {
    clearTimeout(throttleTimers.get(key)); throttleTimers.delete(key);
    const latest = throttleValues.get(key); throttleValues.delete(key);
    if (latest) act(latest);
  };
  if (immediate) flush();
  else if (!throttleTimers.has(key)) throttleTimers.set(key, setTimeout(flush, 40));
}
function updateRange(input, value) {
  if (!touching.has(input)) input.value = Math.round(value);
  input.style.setProperty('--level', `${input.value}%`);
  input.disabled = !online;
}
function connectSocket() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('message', event => {
    lastReceived = Date.now();
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      const first = !state;
      state = message; online = true;
      selected = new Set([...selected].filter(id => state.fixtures.some(f => f.id === id)));
      if (first && state.fixtures.length) selected.add(state.fixtures[0].id);
      render();
    } else {
      const request = pending.get(message.requestId);
      if (request) {
        clearTimeout(request.timer); pending.delete(message.requestId);
        if (message.type === 'error') request.reject(new Error(message.message)); else request.resolve();
      } else if (message.type === 'error') toast(message.message);
    }
  });
  ws.addEventListener('close', () => {
    online = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Controller disconnected.')); }
    pending.clear();
    for (const timer of throttleTimers.values()) clearTimeout(timer);
    throttleTimers.clear(); throttleValues.clear();
    render(); reconnectTimer = setTimeout(connectSocket, 1500);
  });
  ws.addEventListener('error', () => ws.close());
}
// Detect an interrupted network even before the browser closes its socket.
setInterval(() => { if (online && Date.now() - lastReceived > 35000) ws.close(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws?.readyState === WebSocket.CLOSED) connectSocket(); });

function fixtureColor(f) {
  return f.channels.some(c => ['red', 'green', 'blue'].includes(c.kind)) ? rgb(f.levels) : '#e0d3aa';
}
function render() {
  if (!state) {
    $('#connection-label').textContent = 'Connecting…';
    $$('main button, main input').forEach(el => { el.disabled = true; });
    return;
  }
  $$('main button').forEach(el => { el.disabled = !online; });
  const { status, fixtures } = state;
  if (!state.adapters.some(a => a.id === outputId)) {
    outputId = state.adapters[0].id;
    if ($('#output-dialog').open) loadAdapter();
  }
  $('#connection-label').textContent = !online ? 'Offline' : status.connecting ? 'Connecting…' : status.error ? 'Output error' : status.connected ? `${status.connectedCount} output${status.connectedCount > 1 ? 's' : ''} live` : 'Preview mode';
  $('#connection-dot').className = `status-dot${!online || status.error ? ' error' : status.connected ? ' live' : ''}`;
  $('#server-status').textContent = online ? 'Controller connected' : 'Offline · reconnecting';
  $('#server-dot').className = `small-dot${online ? '' : ' error'}`;
  $('#blackout').setAttribute('aria-pressed', String(state.blackout));
  $('#blackout span').textContent = state.blackout ? 'Restore lights' : 'Blackout';
  const houses = fixtures.filter(isMqtt), independent = houses.some(f => !f.followDesk);
  const notice = !online ? 'Connection lost. Controls are paused; the controller holds its last output. Reconnecting…' : status.error || state.persistenceError || (state.blackout ? `Stage blackout is on. Your levels are preserved.${independent ? ' Independent house lights keep their levels.' : ''} Tap “Restore lights” to bring stage lights back.` : '');
  $('#notice').hidden = !notice; $('#notice').textContent = notice;
  $('#notice').className = `notice${state.blackout && online && !status.error && !state.persistenceError ? ' blackout-notice' : ''}`;
  $('#fixture-count').textContent = fixtures.length;
  $('#stage-empty').hidden = !!fixtures.length;
  $('#stage-caption').textContent = status.connected ? `${status.connectedCount} / ${state.adapters.length} adapters sending` : 'Preview · no physical output';
  $('#channel-count').textContent = `${fixtures.filter(f => !isMqtt(f)).reduce((sum, f) => sum + f.channels.length, 0)} DMX channels · ${houses.length ? `${houses.length} house lights` : `${state.adapters.length} adapters`}`;
  $('.master-note').textContent = houses.length ? 'House lights follow this only when opted in.' : 'A little softer. A little brighter.';
  $('#master-value').textContent = Math.round(state.master); updateRange($('#master'), state.master);
  $('#stage').classList.toggle('arranging', arranging);
  $('#arrange').setAttribute('aria-pressed', String(arranging));
  $('#arrange').innerHTML = `${icon('move')}${arranging ? 'Done' : 'Arrange'}`;
  $('#stage-hint').textContent = arranging ? 'Drag your lights into place. Positions save automatically.' : 'Tap a fixture to adjust it. Select all to work together.';
  renderStage(); renderInspector(); renderScenes(); updateOutputStatus();
}
function renderStage() {
  const signature = JSON.stringify([state.fixtures.map(f => [f.id, f.name, f.address, f.channels.length, f.adapterId, f.mqttDevice, f.followDesk]), state.adapters.map(a => [a.id, a.name, a.config.mode, adapterUniverse(a)])]);
  if (signature !== stageSignature) {
    stageSignature = signature;
    $$('.stage-fixture').forEach(el => el.remove());
    $('#fixture-strips').innerHTML = '';
    for (const [i, f] of state.fixtures.entries()) {
      const button = document.createElement('button');
      button.className = 'stage-fixture'; button.dataset.id = f.id;
      const adapter = state.adapters.find(a => a.id === f.adapterId), universe = adapterUniverse(adapter);
      button.innerHTML = `<span class="fixture-disc">${icon(isMqtt(f) ? 'sun' : 'light')}</span><span class="fixture-number">${i + 1}</span><span class="fixture-name">${esc(f.name)}</span><span class="fixture-address">${isMqtt(f) ? `ZIGBEE · ${f.followDesk ? 'DESK' : 'HOUSE'}` : `U ${universe} · CH ${pretty(f.address)}`}</span>`;
      button.title = `${f.name} · ${adapter.name} · ${isMqtt(f) ? f.mqttDevice : `Universe ${universe}`}`;
      button.addEventListener('click', e => {
        if (arranging) return;
        selectFixture(f.id, e.shiftKey || e.metaKey || e.ctrlKey);
      });
      button.addEventListener('pointerdown', e => {
        if (!arranging || !online || e.button !== 0) return;
        e.preventDefault(); selectFixture(f.id);
        const rect = $('#stage').getBoundingClientRect(), current = state.fixtures.find(current => current.id === f.id);
        drag = { id: f.id, pointerId: e.pointerId, x: current.x, y: current.y, offsetX: e.clientX - (rect.left + current.x / 100 * rect.width), offsetY: e.clientY - (rect.top + current.y / 100 * rect.height) };
        button.setPointerCapture(e.pointerId);
      });
      button.addEventListener('pointermove', e => {
        if (drag?.id !== f.id || drag.pointerId !== e.pointerId) return;
        const rect = $('#stage').getBoundingClientRect();
        drag.x = Math.max(9, Math.min(91, (e.clientX - rect.left - drag.offsetX) / rect.width * 100));
        drag.y = Math.max(20, Math.min(76, (e.clientY - rect.top - drag.offsetY) / rect.height * 100));
        button.style.left = `${drag.x}%`; button.style.top = `${drag.y}%`;
      });
      const finish = e => {
        if (drag?.id !== f.id || drag.pointerId !== e.pointerId) return;
        const pos = { x: drag.x, y: drag.y }; drag = null;
        const current = state.fixtures.find(current => current.id === f.id);
        if (current) Object.assign(current, pos);
        act({ type: 'position', id: f.id, ...pos });
      };
      button.addEventListener('pointerup', finish);
      button.addEventListener('pointercancel', finish);
      button.addEventListener('keydown', e => {
        if (!arranging || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const current = state.fixtures.find(current => current.id === f.id), step = e.shiftKey ? 5 : 1;
        const x = Math.max(9, Math.min(91, current.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0)));
        const y = Math.max(20, Math.min(76, current.y + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0)));
        act({ type: 'position', id: f.id, x, y });
      });
      $('#stage').append(button);
      const strip = document.createElement('div'); strip.className = 'fixture-strip'; strip.dataset.id = f.id;
      strip.innerHTML = `<div class="strip-heading"><button type="button" aria-label="Select ${esc(f.name)}"><span class="color-dot"></span><span>${esc(f.name)}</span></button><span class="strip-value">75%</span></div><input type="range" min="0" max="100" step="1" aria-label="${esc(f.name)} intensity">`;
      $('button', strip).addEventListener('click', () => selectFixture(f.id));
      bindRange($('input', strip), value => ({ type: 'levels', ids: [f.id], levels: { intensity: value } }), `fixture-${f.id}`, value => { const current = state.fixtures.find(current => current.id === f.id); current.levels.intensity = value; render(); });
      $('#fixture-strips').append(strip);
    }
  }
  for (const f of state.fixtures) {
    const button = $$('.stage-fixture').find(el => el.dataset.id === f.id), strip = $$('.fixture-strip').find(el => el.dataset.id === f.id);
    const color = fixtureColor(f);
    button.style.setProperty('--fixture-color', color); strip.style.setProperty('--fixture-color', color);
    button.style.setProperty('--brightness', Math.max(.15, f.levels.intensity / 100 * (followsDesk(f) ? state.master / 100 : 1)));
    if (drag?.id !== f.id) { button.style.left = `${f.x}%`; button.style.top = `${f.y}%`; }
    button.classList.toggle('selected', selected.has(f.id));
    button.classList.toggle('off', followsDesk(f) && (state.blackout || state.master === 0) || f.levels.intensity === 0);
    button.setAttribute('aria-pressed', String(selected.has(f.id)));
    button.setAttribute('aria-label', `${f.name}, ${isMqtt(f) ? 'house dimmer' : `channel ${f.address}`}${arranging ? ', drag or use arrow keys to arrange' : ''}`);
    button.disabled = !online;
    $('.strip-value', strip).textContent = `${Math.round(f.levels.intensity)}%`;
    updateRange($('input', strip), f.levels.intensity);
  }
}
function selectFixture(id, additive = false) {
  if (additive) selected.has(id) ? selected.delete(id) : selected.add(id);
  else selected = new Set([id]);
  render();
}
function bindRange(input, message, key, optimistic) {
  input.addEventListener('pointerdown', () => touching.add(input));
  for (const event of ['pointerup', 'pointercancel', 'blur']) input.addEventListener(event, () => touching.delete(input));
  input.addEventListener('input', () => {
    const value = Number(input.value); input.style.setProperty('--level', `${value}%`);
    optimistic?.(value); throttle(key, message(value));
  });
  input.addEventListener('change', () => {
    touching.delete(input); throttle(key, message(Number(input.value)), true);
  });
}
function renderInspector() {
  const fixtures = state.fixtures.filter(f => selected.has(f.id));
  const kinds = new Set(fixtures.flatMap(f => f.channels.map(c => c.kind)));
  const hasColor = ['red', 'green', 'blue'].some(k => kinds.has(k));
  const signature = JSON.stringify([fixtures.map(f => [f.id, isMqtt(f)]), [...kinds]]);
  $('#selected-title').textContent = fixtures.length > 1 ? `${fixtures.length} fixtures` : fixtures[0]?.name || 'No fixture selected';
  const adapter = fixtures.length === 1 ? state.adapters.find(a => a.id === fixtures[0].adapterId) : null;
  $('#selected-meta').textContent = fixtures.length > 1 ? 'Adjust selected fixtures across adapters' : fixtures.length ? (isMqtt(fixtures[0]) ? `${fixtures[0].mqttDevice} · ${fixtures[0].followDesk ? 'Follows desk' : 'Independent house light'}` : `${adapter.name} · ${adapter.config.mode === 'artnet' ? 'Art-Net' : 'U'} ${adapterUniverse(adapter)} · CH ${pretty(fixtures[0].address)}–${pretty(fixtures[0].address + fixtures[0].channels.length - 1)}`) : '';
  $('#no-selection').hidden = !!fixtures.length;
  if (signature !== inspectorSignature) {
    inspectorSignature = signature;
    const controls = $('#selection-controls'); controls.innerHTML = '';
    if (!fixtures.length) return;
    controls.innerHTML = '<div class="level-label"><label for="selected-intensity">Intensity</label><output id="selected-intensity-value">75%</output></div><input id="selected-intensity" type="range" min="0" max="100" aria-label="Selected fixture intensity">';
    bindRange($('#selected-intensity'), value => ({ type: 'levels', ids: [...selected], levels: { intensity: value } }), 'selected-intensity', value => { for (const f of state.fixtures.filter(f => selected.has(f.id))) f.levels.intensity = value; render(); });
    if (fixtures.some(isMqtt)) controls.insertAdjacentHTML('beforeend', '<p id="mqtt-feedback" class="mqtt-feedback"></p>');
    if (hasColor) {
      controls.insertAdjacentHTML('beforeend', `<div class="color-label"><span>Color palette</span><code id="selected-hex"></code></div><div class="color-swatches">${colors.map(([label, color]) => `<button type="button" class="swatch" style="--swatch:${color}" aria-label="${label}" data-color="${color}"><span></span></button>`).join('')}</div><label class="custom-color">Custom color<input type="color" id="custom-color" aria-label="Custom fixture color"></label>`);
      $$('.swatch').forEach(button => button.addEventListener('click', () => act({ type: 'levels', ids: [...selected], levels: fromHex(button.dataset.color) })));
      $('#custom-color').addEventListener('input', e => throttle('color', { type: 'levels', ids: [...selected], levels: fromHex(e.target.value) }));
      $('#custom-color').addEventListener('change', e => throttle('color', { type: 'levels', ids: [...selected], levels: fromHex(e.target.value) }, true));
    }
    const levels = [...(hasColor ? ['red', 'green', 'blue'].filter(k => kinds.has(k)) : []), ...['white', 'amber', 'uv'].filter(k => kinds.has(k))];
    for (const kind of levels) {
      controls.insertAdjacentHTML('beforeend', `<div class="level-label"><label for="level-${kind}">${kind === 'uv' ? 'UV' : kind[0].toUpperCase() + kind.slice(1)}</label><output id="value-${kind}">0%</output></div><input id="level-${kind}" type="range" min="0" max="100" aria-label="${kind} level" style="--track-color:${({ red: '#eb7777', green: '#9cc686', blue: '#86a3e5', white: '#e6e9dd', amber: '#e7b55d', uv: '#bd8cde' })[kind]}">`);
      bindRange($(`#level-${kind}`), value => ({ type: 'levels', ids: [...selected], levels: { [kind]: value } }), `level-${kind}`, value => { for (const f of state.fixtures.filter(f => selected.has(f.id))) f.levels[kind] = value; render(); });
    }
  }
  if (!fixtures.length) return;
  const first = fixtures[0], mixed = kind => fixtures.some(f => Math.abs(f.levels[kind] - first.levels[kind]) > .5);
  if ($('#mqtt-feedback')) {
    $('#mqtt-feedback').textContent = fixtures.filter(isMqtt).map(f => {
      const status = state.adapterStatuses[f.adapterId], reported = status?.reported?.[f.id];
      const description = !status?.connected ? 'MQTT disconnected' : status.bridgeOnline === false ? 'Zigbee2MQTT offline' : reported?.available === false ? 'Device offline' : reported?.level !== undefined ? `Reported: ${Math.round(reported.level)}%` : 'Waiting for device feedback';
      return `${fixtures.length > 1 ? `${f.name}: ` : ''}${description}`;
    }).join(' · ');
  }
  $('#selected-intensity-value').textContent = mixed('intensity') ? 'Mixed' : `${Math.round(first.levels.intensity)}%`;
  updateRange($('#selected-intensity'), first.levels.intensity);
  for (const kind of ['red', 'green', 'blue', 'white', 'amber', 'uv']) if ($(`#level-${kind}`)) {
    updateRange($(`#level-${kind}`), first.levels[kind]);
    $(`#value-${kind}`).textContent = mixed(kind) ? 'Mixed' : `${Math.round(first.levels[kind])}%`;
  }
  if (hasColor) {
    const hex = rgb(first.levels), colorMixed = ['red', 'green', 'blue'].some(mixed);
    $('#selected-hex').textContent = colorMixed ? 'MIXED' : hex.toUpperCase();
    if (document.activeElement !== $('#custom-color')) $('#custom-color').value = hex;
    $('#custom-color').disabled = !online;
    $$('.swatch').forEach(button => { button.classList.toggle('active', !colorMixed && button.dataset.color === hex); button.disabled = !online; });
  }
}
function renderScenes() {
  const signature = JSON.stringify([state.scenes, editingScenes]);
  if (signature !== sceneSignature) {
    sceneSignature = signature;
    $('#scenes').innerHTML = state.scenes.map(scene => {
      const levels = Object.values(scene.fixtures), a = levels.length ? rgb(levels[0]) : '#aaa', b = levels.length > 1 ? rgb(levels[1]) : a;
      return `<div class="scene-wrap" data-id="${esc(scene.id)}"><button class="scene" style="--scene-a:${a};--scene-b:${b}" aria-label="Recall ${esc(scene.name)}" aria-pressed="false"><div class="scene-art"><span class="scene-play">▶</span></div><div class="scene-info"><strong>${esc(scene.name)}</strong><small>${scene.fade ? `${scene.fade}s fade` : 'Instant'} · ${Math.round(scene.master)}%</small></div></button>${editingScenes ? `<button class="scene-delete" aria-label="Delete ${esc(scene.name)}">${icon('trash')}</button>` : ''}</div>`;
    }).join('') || '<p>No scenes yet. Save your first look.</p>';
    $$('.scene-wrap').forEach(wrap => {
      $('.scene', wrap).addEventListener('click', () => act({ type: 'recallScene', id: wrap.dataset.id }));
      $('.scene-delete', wrap)?.addEventListener('click', () => act({ type: 'deleteScene', id: wrap.dataset.id }));
    });
  }
  $$('.scene-wrap').forEach(wrap => {
    const button = $('.scene', wrap); button.classList.toggle('active', wrap.dataset.id === state.activeScene); button.setAttribute('aria-pressed', String(wrap.dataset.id === state.activeScene)); button.disabled = !online;
    if ($('.scene-delete', wrap)) $('.scene-delete', wrap).disabled = !online;
  });
  const scene = state.scenes.find(scene => scene.id === state.activeScene);
  $('#scene-status').textContent = scene ? `${state.fading ? 'Fading to' : 'Current scene:'} ${scene.name}${state.blackout ? ' · blackout on' : ''}` : 'Pick a scene. Find your atmosphere.';
  $('#manage-scenes').setAttribute('aria-pressed', String(editingScenes)); $('#manage-scenes').textContent = editingScenes ? 'Done' : 'Edit';
}

$('#select-all').addEventListener('click', () => { selected = new Set(state.fixtures.map(f => f.id)); render(); });
$('#arrange').addEventListener('click', () => { arranging = !arranging; render(); });
$('#blackout').addEventListener('click', () => act({ type: 'blackout', value: !state.blackout }));
$('#live-nav').addEventListener('click', () => { $$('dialog[open]').forEach(d => d.close()); window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('#manage-scenes').addEventListener('click', () => { editingScenes = !editingScenes; render(); });
bindRange($('#master'), value => ({ type: 'master', value }), 'master', value => { state.master = value; render(); });
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.repeat || !online || $('dialog[open]') || e.target.closest('input,select,textarea,button,a,[contenteditable]')) return;
  e.preventDefault(); act({ type: 'blackout', value: !state.blackout });
});
$$('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));

function updateOutputFields() {
  const mode = $('#output-mode').value;
  for (const kind of ['sacn', 'artnet', 'usb', 'mqtt', 'preview']) {
    const fields = $(`#${kind}-fields`);
    fields.hidden = mode !== kind;
    $$('input,select', fields).forEach(input => { input.disabled = fields.hidden; });
  }
  const network = mode === 'sacn' || mode === 'artnet';
  $('#network-fields').hidden = !network;
  $('#network-destination').disabled = !network;
  $('#network-interface').disabled = !network;
  $('#network-destination').required = mode === 'artnet';
  $('#network-destination').placeholder = mode === 'artnet' ? 'e.g. 192.168.1.20' : 'Leave blank for multicast';
  $('#network-note').textContent = mode === 'artnet' ? 'Enter the node’s unicast IP. Art-Net port-addresses start at 0. Match the address on your node; some node menus number universes from 1.' : 'Unicast: enter your DMX node’s IP. Multicast: leave it blank. Match the universe on the receiver.';
  updateArtnetAddress();
  $('#connect-note').textContent = mode === 'mqtt' ? 'Connecting reads device state. Lights change when you adjust a dimmer or recall a scene; disconnecting leaves them at their last level.' : 'Connecting a DMX adapter starts stage blackout. Connect your adapters, then tap “Restore lights” when ready.';
  $('#connect-output').hidden = mode === 'preview';
}
function updateArtnetAddress() {
  const value = Number($('#artnet-universe').value);
  $('#artnet-address-hint').textContent = Number.isInteger(value) && value >= 0 && value <= 32767 ? `Net ${value >> 8} / Sub-Net ${(value >> 4) & 15} / Universe ${value & 15}` : 'Enter a port-address from 0 to 32767.';
}
$('#artnet-universe').addEventListener('input', updateArtnetAddress);
function updateOutputStatus() {
  if (!state) return;
  const adapter = state.adapters.find(a => a.id === outputId), status = state.adapterStatuses[outputId];
  if (!adapter || !status) return;
  $('#output-state').textContent = status.error || (status.connected ? adapter.config.mode === 'mqtt' ? `MQTT connected · ${status.frames} commands sent · ${status.devices?.length ?? 0} dimmers discovered` : `${status.frames} frames sent · ${adapter.config.mode === 'usb' ? 'OLA accepted DMX; check USB patch in OLA' : 'UDP sent; receiver response is not available'}` : 'This adapter is disconnected.');
  $('#disconnect-output').hidden = !status.connected;
  const assigned = state.fixtures.filter(f => f.adapterId === outputId).length;
  $('#adapter-assignment').textContent = `${assigned} fixture${assigned !== 1 ? 's' : ''} assigned${assigned ? ' · reassign in Fixture patch before removing' : ''}`;
  $('#remove-adapter').disabled = !online || !!assigned || state.adapters.length === 1;
}
function loadAdapter() {
  const form = $('#output-form'), adapter = state.adapters.find(a => a.id === outputId);
  $('#adapter-select').innerHTML = state.adapters.map(a => `<option value="${esc(a.id)}">${esc(a.name)} · ${adapterDescription(a)}</option>`).join('');
  $('#adapter-select').value = outputId;
  form.elements.adapterName.value = adapter.name;
  form.elements.artnetUniverse.value = adapter.config.artnetUniverse ?? 0;
  form.elements.mqttUrl.value = adapter.config.mqttUrl ?? 'mqtt://127.0.0.1:1883';
  form.elements.mqttBaseTopic.value = adapter.config.mqttBaseTopic ?? 'zigbee2mqtt';
  form.elements.mqttUsername.value = adapter.config.mqttUsername ?? '';
  form.elements.mqttPassword.value = ''; $('#clear-mqtt-password').checked = false;
  form.elements.mqttPassword.placeholder = adapter.config.mqttPasswordSet ? 'Saved · leave blank to keep' : 'Broker password (if required)';
  for (const [key, value] of Object.entries(adapter.config)) if (key !== 'mqttPassword' && form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
  const iface = adapter.config.interface;
  if (iface && !$$('option', $('#network-interface')).some(o => o.value === iface)) $('#network-interface').insertAdjacentHTML('beforeend', `<option value="${esc(iface)}">${esc(iface)} (saved)</option>`);
  $('#network-interface').value = iface;
  $('#output-error').textContent = ''; updateOutputFields(); updateOutputStatus();
}
$('#adapter-select').addEventListener('change', e => { outputId = e.target.value; loadAdapter(); });
$('#add-adapter').addEventListener('click', async () => {
  try {
    const nextUniverse = Math.max(...state.adapters.map(a => a.config.universe)) + 1;
    const config = { ...state.adapters[0].config, mode: 'sacn', universe: Math.min(63999, nextUniverse), destination: '', interface: '', olaUniverse: Math.min(63999, nextUniverse) };
    await send({ type: 'addAdapter', name: `Adapter ${state.adapters.length + 1}`, config });
    outputId = state.adapters.at(-1).id; loadAdapter(); toast('Adapter added. Assign fixtures in Fixture patch.');
  } catch (e) { $('#output-error').textContent = e.message; }
});
$('#remove-adapter').addEventListener('click', async () => {
  try { await send({ type: 'removeAdapter', adapterId: outputId }); outputId = state.adapters[0].id; loadAdapter(); }
  catch (e) { $('#output-error').textContent = e.message; }
});
$('#output-mode').addEventListener('change', updateOutputFields);
$('#output-nav').addEventListener('click', async () => {
  if (!state) return;
  loadAdapter(); $('#output-dialog').showModal();
  try {
    const res = await fetch('/api/interfaces'), interfaces = await res.json();
    $('#network-interface').innerHTML = '<option value="">Automatic</option>' + interfaces.map(i => `<option value="${esc(i.address)}">${esc(i.name)} · ${esc(i.address)}</option>`).join('');
    const iface = state.adapters.find(a => a.id === outputId).config.interface;
    if (iface && !interfaces.some(i => i.address === iface)) $('#network-interface').insertAdjacentHTML('beforeend', `<option value="${esc(iface)}">${esc(iface)} (saved)</option>`);
    $('#network-interface').value = iface;
  } catch { /* Automatic network interface remains usable. */ }
});
function outputConfig() {
  const data = { artnetUniverse: 0, mqttUrl: 'mqtt://127.0.0.1:1883', mqttBaseTopic: 'zigbee2mqtt', mqttUsername: '', ...state.adapters.find(a => a.id === outputId).config, ...Object.fromEntries(new FormData($('#output-form'))) };
  if (!data.mqttPassword) delete data.mqttPassword;
  if ($('#clear-mqtt-password').checked) data.mqttPassword = '';
  for (const key of ['universe', 'artnetUniverse', 'priority', 'olaUniverse']) data[key] = Number(data[key]);
  return data;
}
async function saveOutput(connect) {
  const form = $('#output-form');
  if (!form.reportValidity()) return;
  const buttons = $$('button', form); buttons.forEach(b => { b.disabled = true; });
  $('#output-error').textContent = '';
  try {
    await send({ type: 'output', adapterId: outputId, name: form.elements.adapterName.value, config: outputConfig() });
    if (connect) await send({ type: 'connect', adapterId: outputId });
    $('#output-dialog').close(); toast(connect ? ($('#output-mode').value === 'mqtt' ? 'MQTT connected. Assign house dimmers in Fixture patch.' : 'Output connected. Restore lights when ready.') : 'Output settings saved.');
  } catch (e) { $('#output-error').textContent = e.message; }
  finally { buttons.forEach(b => { b.disabled = false; }); }
}
$('#output-form').addEventListener('submit', e => { e.preventDefault(); saveOutput(false); });
$('#connect-output').addEventListener('click', () => saveOutput(true));
$('#disconnect-output').addEventListener('click', async () => {
  try { await send({ type: 'disconnect', adapterId: outputId }); toast('Adapter disconnected.'); } catch (e) { $('#output-error').textContent = e.message; }
});

function renderPatch() {
  const options = state.library.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#patch-rows').innerHTML = patchDraft.map((f, i) => `<div class="patch-row" data-index="${i}"><label>Fixture name<input value="${esc(f.name)}" data-field="name" maxlength="64" required aria-label="Fixture ${i + 1} name"></label><label>Profile<select data-field="profile" aria-label="Fixture ${i + 1} profile">${options}</select></label><label>Address<input type="number" min="1" max="${513 - f.channels.length}" value="${f.address}" data-field="address" required aria-label="Fixture ${i + 1} address"></label><button type="button" class="icon-button remove-fixture" aria-label="Remove ${esc(f.name)}">${icon('trash')}</button><div class="channel-map">${f.channels.map((c, n) => `${n + 1}: ${esc(c.label)}${c.kind === 'fixed' ? ` (${c.value})` : ''}`).join(' · ')} <button type="button" class="quiet-button customize-profile">Customize map</button></div></div>`).join('');
  $$('.patch-row').forEach(row => {
    const index = Number(row.dataset.index), f = patchDraft[index], select = $('select', row);
    const profile = state.library.find(p => p.name === f.profileName && JSON.stringify(p.channels) === JSON.stringify(f.channels));
    if (profile) select.value = profile.id;
    else { select.insertAdjacentHTML('beforeend', `<option value="embedded">${esc(f.profileName)} (fixture map)</option>`); select.value = 'embedded'; }
    const adapterLabel = document.createElement('label'); adapterLabel.className = 'adapter-field';
    adapterLabel.innerHTML = `Output adapter<select aria-label="Fixture ${index + 1} adapter">${state.adapters.map(a => `<option value="${esc(a.id)}">${esc(a.name)} · ${adapterDescription(a)}</option>`).join('')}</select>`;
    $('select', adapterLabel).value = f.adapterId;
    $('select', adapterLabel).addEventListener('change', e => {
      f.adapterId = e.target.value;
      if (state.adapters.find(a => a.id === f.adapterId).config.mode === 'mqtt') {
        f.channels = [{ kind: 'dimmer', label: 'dimmer', value: 0 }]; f.profileName = 'Zigbee2MQTT dimmer'; f.address = 1;
        f.mqttDevice ??= ''; f.mqttMaxBrightness ??= 254; f.followDesk ??= false;
      }
      renderPatch();
    });
    row.insertBefore(adapterLabel, $('.channel-map', row));
    const mqtt = state.adapters.find(a => a.id === f.adapterId).config.mode === 'mqtt';
    if (mqtt) {
      select.closest('label').hidden = true; select.disabled = true;
      const address = $('[data-field=address]', row); address.closest('label').hidden = true; address.disabled = true;
      const devices = state.adapterStatuses[f.adapterId]?.devices ?? [], listId = `mqtt-devices-${index}`;
      $('.channel-map', row).innerHTML = `<div class="mqtt-fixture-fields"><div class="form-grid"><label>Device or group name<input data-field="mqttDevice" value="${esc(f.mqttDevice ?? '')}" maxlength="128" required list="${listId}" aria-label="Fixture ${index + 1} MQTT device" placeholder="e.g. house_lights"><datalist id="${listId}">${devices.map(d => `<option value="${esc(d.name)}"></option>`).join('')}</datalist></label><label>Maximum brightness<input data-field="mqttMaxBrightness" type="number" min="1" max="255" value="${f.mqttMaxBrightness ?? 254}" required aria-label="Fixture ${index + 1} maximum brightness"></label></div><label class="checkbox-label"><input type="checkbox" data-field="followDesk" ${f.followDesk ? 'checked' : ''} aria-label="Fixture ${index + 1} follows master and blackout">Follow stage master and blackout</label><p class="field-note">Use the exact Zigbee2MQTT friendly name or group. Default maximum is 254; discovered devices fill this automatically. House dimmers are included when saving new scenes.</p></div>`;
    }
    $$('input', row).forEach(input => input.addEventListener('input', () => {
      const field = input.dataset.field;
      f[field] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      if (field === 'mqttDevice') {
        const device = state.adapterStatuses[f.adapterId]?.devices?.find(d => d.name === input.value);
        if (device && device.maxBrightness >= 1 && device.maxBrightness <= 255) { f.mqttMaxBrightness = device.maxBrightness; $('[data-field=mqttMaxBrightness]', row).value = device.maxBrightness; }
      }
    }));
    select.addEventListener('change', () => {
      const p = state.library.find(p => p.id === select.value);
      if (p) { f.channels = clone(p.channels); f.profileName = p.name; renderPatch(); }
    });
    $('.remove-fixture', row).addEventListener('click', () => { patchDraft.splice(index, 1); renderPatch(); });
    $('.customize-profile', row)?.addEventListener('click', () => openProfile(index));
  });
}
$('#patch-nav').addEventListener('click', () => {
  if (!state) return;
  patchDraft = clone(state.fixtures); $('#patch-error').textContent = ''; renderPatch(); $('#patch-dialog').showModal();
});
$('#add-fixture').addEventListener('click', () => {
  if (patchDraft.length >= 32) { $('#patch-error').textContent = 'Maximum 32 fixtures.'; return; }
  const adapterId = state.adapters[0].id;
  const mqtt = state.adapters[0].config.mode === 'mqtt';
  const occupied = new Set(patchDraft.filter(f => f.adapterId === adapterId).flatMap(f => f.channels.map((_, i) => f.address + i)));
  let address = 1;
  while (!mqtt && address <= 510 && [0, 1, 2].some(i => occupied.has(address + i))) address++;
  if (address > 510) { $('#patch-error').textContent = 'No free 3-channel range remains.'; return; }
  const profile = state.library.find(p => p.id === (mqtt ? 'dimmer-1' : 'rgb-3'));
  patchDraft.push({ id: makeId(), adapterId, name: `Fixture ${patchDraft.length + 1}`, profileName: profile.name, channels: clone(profile.channels), address, x: 20 + Math.random() * 60, y: 35 + Math.random() * 25,
    ...(mqtt ? { mqttDevice: '', mqttMaxBrightness: 254, followDesk: false } : {}),
    levels: { intensity: 0, red: 100, green: 100, blue: 100, white: 0, amber: 0, uv: 0 } });
  renderPatch();
});
$('#patch-form').addEventListener('submit', async e => {
  e.preventDefault(); $('#patch-error').textContent = '';
  try { await send({ type: 'patch', fixtures: patchDraft }); $('#patch-dialog').close(); toast('Fixture patch saved.'); }
  catch (e) { $('#patch-error').textContent = e.message; }
});
function openProfile(index = null) {
  profileTarget = index;
  const fixture = index === null ? null : patchDraft[index];
  profileDraft = fixture ? clone(fixture.channels) : ['red', 'green', 'blue'].map(kind => ({ kind, label: kind[0].toUpperCase() + kind.slice(1), value: 0 }));
  $('#profile-form').elements.profileName.value = fixture ? `${fixture.profileName} custom` : '';
  $('#profile-error').textContent = ''; renderProfile(); $('#profile-dialog').showModal();
}
function renderProfile() {
  const kinds = ['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'fixed'];
  $('#profile-channels').innerHTML = profileDraft.map((c, i) => `<div class="profile-row"><span>${i + 1}</span><input value="${esc(c.label)}" maxlength="64" required aria-label="Channel ${i + 1} label"><select aria-label="Channel ${i + 1} control">${kinds.map(k => `<option value="${k}" ${k === c.kind ? 'selected' : ''}>${k === 'fixed' ? 'Fixed value' : k === 'uv' ? 'UV' : k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select><input type="number" min="0" max="255" value="${c.value}" ${c.kind !== 'fixed' ? 'disabled' : 'required'} aria-label="Channel ${i + 1} fixed value"><button type="button" class="icon-button" aria-label="Remove channel ${i + 1}">${icon('close')}</button></div>`).join('');
  $$('.profile-row').forEach((row, i) => {
    const inputs = $$('input', row);
    inputs[0].addEventListener('input', () => { profileDraft[i].label = inputs[0].value; });
    inputs[1].addEventListener('input', () => { profileDraft[i].value = Number(inputs[1].value); });
    $('select', row).addEventListener('change', e => { profileDraft[i].kind = e.target.value; inputs[1].disabled = e.target.value !== 'fixed'; inputs[1].required = e.target.value === 'fixed'; });
    $('button', row).addEventListener('click', () => { profileDraft.splice(i, 1); renderProfile(); });
  });
}
$('#new-profile').addEventListener('click', () => openProfile());
$('#add-channel').addEventListener('click', () => { if (profileDraft.length < 512) { profileDraft.push({ kind: 'fixed', label: `Channel ${profileDraft.length + 1}`, value: 0 }); renderProfile(); } });
$('#profile-form').addEventListener('submit', async e => {
  e.preventDefault(); $('#profile-error').textContent = '';
  const profileName = e.target.elements.profileName.value.trim();
  try {
    await send({ type: 'profile', name: profileName, channels: profileDraft });
    if (profileTarget !== null) { patchDraft[profileTarget].profileName = profileName; patchDraft[profileTarget].channels = clone(profileDraft); }
    renderPatch(); $('#profile-dialog').close(); toast('Custom profile saved to your library.');
  } catch (e) { $('#profile-error').textContent = e.message; }
});
$('#save-scene').addEventListener('click', () => { $('#scene-form').reset(); $('#scene-error').textContent = ''; $('#scene-dialog').showModal(); });
$('#scene-form').addEventListener('submit', async e => {
  e.preventDefault(); $('#scene-error').textContent = '';
  try {
    await send({ type: 'saveScene', name: e.target.elements.sceneName.value, fade: Number(e.target.elements.fade.value) });
    $('#scene-dialog').close(); toast('Scene saved.');
  } catch (e) { $('#scene-error').textContent = e.message; }
});
render(); connectSocket();
