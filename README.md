# DMX Control

A small lighting desk for a Raspberry Pi, controlled from an iPad or any modern browser. The Node.js server generates DMX; the browser is the touch interface. No frontend build, cloud service, or internet connection is required once installed.

## Run locally

Install Node.js 22 or newer, then:

```sh
npm ci
npm start
```

Open `http://localhost:3000`. On an iPad on the same network, open `http://<controller-ip>:3000` in Safari. The server listens on all interfaces by default.

Start in preview mode to try the controls without hardware. Two generic 3-channel RGB fixtures are initially patched at addresses **1** and **4**.

## Control your lights

- Tap a fixture on the stage to adjust its intensity and color. **Select all** adjusts the whole group; desktop users can Shift-click to select individual fixtures together.
- Tap **Arrange**, drag lights to match the room, then tap **Done**. Positions save on the controller and appear on every connected browser. Arrow keys also move fixtures while arranging; Shift makes larger steps.
- The master dimmer scales DMX fixtures and house dimmers explicitly set to follow the desk. RGB-only lights are dimmed by scaling RGB; profiles with a dedicated dimmer use that channel instead, avoiding double dimming.
- **Blackout** zeros DMX universes and MQTT house dimmers opted into desk control, while preserving your levels. **Restore lights** brings them back. Space toggles blackout when you are not editing a field or dialog.
- Scenes save fixture levels and master intensity with a configurable 0–100 second fade. They do not change positions, patching, output settings, or blackout. Editing a level interrupts a fade. A scene only affects fixture IDs it captured; newly added fixtures keep their current levels.
- Browser tabs stay synchronized. If the browser loses its connection, the server continues sending its last levels. The UI disables controls until it reconnects.

Fixture patch, positions, profiles, scenes, and levels are stored in `data/state.json`. Writes are coalesced to at most once a second and the file is replaced atomically. Back up this file to preserve your setup. A corrupt or incompatible file stops startup with an explanatory error rather than silently replacing your patch.

## Fixture library and custom profiles

**Fixture patch** lets you name, add, and remove up to 32 fixtures across up to 32 output adapters. Each DMX adapter carries one 512-channel universe; a Zigbee2MQTT adapter connects a broker and its house dimmers. Assign each fixture to an output adapter. Addresses cannot overlap on the same adapter or extend beyond channel 512; separate adapters can reuse addresses. Set the same start address and channel mode on the physical light; the app does not configure those automatically.

Included profiles:

- Dimmer, 1 channel
- RGB, 3 channels
- RGBW, 4 channels
- Dimmer + RGB, 4 channels
- Dimmer + RGBW, 5 channels
- RGBWAUV, 6 channels
- Chauvet SlimPAR 56 in 7-CH mode: RGB, color macro, strobe, mode, dimmer. Macro, strobe, and mode default to zero for direct RGB control.

The generic profiles describe channel order, not a universal manufacturer convention. Verify your light's manual. The SlimPAR profile follows the [manufacturer's channel chart](https://www.chauvetdj.com/wp-content/uploads/2015/12/SlimPAR_56_UM_Rev7_WO..pdf); other products and modes may differ.

Choose **Custom profile** to define a named channel map, or **Customize map** to copy an existing fixture's map as a new profile. Add channels in manual order and assign them to dimmer, red, green, blue, white, amber, UV, or a fixed 0–255 DMX value. Fixed values can hold mode, macro, strobe, and unused channels at the desired setting. New profiles are saved to the library and can be selected for any fixture. Saving a profile does not save pending patch edits; tap **Save patch** to apply them.

This version controls dimming and color. Pan/tilt, gobos, fixture effects, RDM discovery, and DMX input are outside its current scope. Multiple adapters and universes are supported; each configured DMX adapter carries one universe. Add a separate logical adapter to send another universe to the same network node.

## Multiple adapters and universes

The output button opens a list of named adapters. **Add adapter** creates another output with its own type, destination, and universe. Name adapters after their positions, for example “Left wash node” and “Right wash node”, then assign fixtures to them in **Fixture patch**.

For a node at each light, both fixtures may start at address 1. Use separate unicast IPs (universes may match), or separate universes when multicasting. Two identical destination/universe pairs are rejected to prevent conflicting streams. Each sACN adapter has a stable, distinct source CID. Art-Net, sACN, and USB/OLA adapters can run together; use distinct OLA universes for separate USB outputs.

**Save & connect** and **Disconnect** affect the selected adapter. Connecting a DMX adapter engages stage blackout; connect all desired DMX adapters, then restore lights. Zigbee2MQTT connections leave current house-light levels unchanged. Scenes include house dimmers, while master and blackout affect them only when opted in. Remove an adapter only after reassigning its fixtures. Old single-output settings migrate automatically to “Main output”.

## Network output: sACN

Open the output button in the header and choose **Network · sACN / E1.31**:

1. Set universe (1–63999) and priority (0–200; default 100).
2. Leave destination blank for multicast, or enter your sACN-to-DMX node's IPv4 address for unicast.
3. Use Automatic routing or choose the controller's local network interface.
4. Tap **Save & connect**, then **Restore lights** when ready.

Each connected network adapter sends its own 512-slot E1.31 data packets at a nominal 30 Hz over UDP port 5568. Multicast destinations are `239.255.<universe high byte>.<universe low byte>`. It sends a zero frame and three stream-terminated packets on a normal disconnect. Each adapter is a single-universe data sender; universe discovery and synchronization packets are not implemented. Packet counts show successful UDP sends, not receiver acknowledgements.

The iPad can use Wi-Fi while the Pi and lighting node use Ethernet. Put the node in sACN mode with the matching universe and check that the network allows multicast if you use it. A regular DMX fixture needs a network-to-DMX node for this path.

## Network output: Art-Net

Choose **Network · Art-Net** for the selected adapter. Enter the node’s unicast IPv4 address and **Art-Net port-address (0-based)**, from 0–32767. The settings show the corresponding Net / Sub-Net / Universe; for example 291 means Net 1, Sub-Net 2, Universe 3. Match the node’s address: some menus display universes starting at 1. Address 0 remains supported for older nodes; newer Art-Net guidance prefers addresses starting at 1.

Each adapter sends full 512-slot ArtDmx packets at a nominal 30 Hz using UDP source and destination port **6454**, with sequences cycling 1–255. **Save & connect** engages global blackout; **Restore lights** starts your saved levels. Disconnect sends a final zero frame. Multiple Art-Net adapters work with separate nodes or separate universes on one node.

This is manually configured ArtDmx unicast output. ArtPoll discovery/subscription, ArtPollReply, broadcast output, ArtSync, and RDM are not implemented. The controller must be able to bind port 6454; close another application if it owns that port exclusively. Physical node interoperability still needs hardware testing.

[Art-Net protocol specification](https://art-net.org.uk/art-net-specification/). Art-Net™ Designed by and Copyright Artistic Licence.

## USB output: OLA

USB dongles speak different protocols. This application sends complete DMX frames to [Open Lighting Architecture (OLA)](https://www.openlighting.org/ola/), which handles the hardware driver and DMX timing on the Pi.

The DSD TECH SH-RS09B pictured during development is a candidate for the FTDI/Open DMX path. Its exact chipset, USB ID, and physical operation have **not** been verified here. Confirm OLA detects your actual cable; USB Pro support does not automatically imply support for an Open DMX cable. OLA documents the differences in its [USB driver FAQ](https://www.openlighting.org/ola/get-help/ola-faq/) and [device-specific setup guide](https://www.openlighting.org/ola/getting-started/device-specific-configuration/).

On Raspberry Pi OS / Debian:

```sh
sudo apt update
sudo apt install ola
```

Start the packaged `olad` service, or run `olad` under the user that owns your OLA configuration. Open `http://<pi-ip>:9090` to use OLA's web interface.

1. Plug in the cable and check the **Devices** and **Plugins** pages.
2. For FTDI/Open DMX cables, use the **FTDI USB DMX** plugin. Resolve competing drivers and USB permissions using OLA's device guide. Depending on your distribution, configuration belongs to the daemon's config directory or its service account's `~/.ola`; check the service command and logs before editing it.
3. Create an OLA universe (for example, **1**) and patch the cable's **output** port to it.
4. Test output in OLA's own DMX console first.
5. In this app, choose **USB dongle · through OLA**, leave URL as `http://127.0.0.1:9090`, and use the same OLA universe.
6. Tap **Save & connect**, then **Restore lights**.

The OLA URL is resolved from the controller, not the iPad. The app sends form-encoded `POST /set_dmx` requests with `u` and 512 comma-separated `d` values, following OLA's [Web API](https://www.openlighting.org/ola/apis/). Only an `ok` response is accepted. Slow transports drop intermediate frames rather than building a stale queue. A successful request means OLA accepted DMX; verify the physical output patch in OLA.

## House lights: Zigbee2MQTT / Mosquitto

The controller can share your existing Mosquitto broker with Home Assistant. Devices stay paired to Zigbee2MQTT; no new Zigbee radio or re-pairing is required. This uses Zigbee2MQTT’s [device/group commands and state topics](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html), alongside its existing [Home Assistant integration](https://www.zigbee2mqtt.io/guide/usage/integrations/home_assistant.html).

Configuration is optional until you are ready:

1. In output settings, **Add adapter**, name it “House lights”, and choose **House lights · Zigbee2MQTT**. Use a separate MQTT adapter rather than converting one with DMX fixtures assigned.
2. Enter your broker URL, for example `mqtt://homeassistant.local:1883` or `mqtts://broker.example:8883`, the Zigbee2MQTT base topic (default `zigbee2mqtt`), and credentials if required. Credentials have separate fields; do not put them in the URL.
3. **Save & connect** reads device feedback and available dimmers. It does not turn lights on or engage stage blackout. The broker user needs permission to read `BASE/bridge/state`, `BASE/bridge/devices`, assigned `BASE/DEVICE` and `BASE/DEVICE/availability` topics, and write assigned `BASE/DEVICE/set` topics.
4. In **Fixture patch**, add a fixture, choose the MQTT adapter, and enter the exact Zigbee2MQTT friendly name or group name. Discovered dimmers offer name suggestions and maximum brightness. A MQTT dimmer uses no DMX address or universe.
5. Check **Maximum brightness** against the device’s Zigbee2MQTT Exposes data. The default is 254; device scales from 1–255 are supported. Names containing folders such as `house/front` are supported. Multi-endpoint brightness properties such as `brightness_l1` are outside this initial dimmer integration.

House dimmers appear on the same draggable stage layout, with an intensity slider and reported brightness. Turning intensity to zero sends `{"state":"OFF"}`; other levels send `{"state":"ON","brightness":N}`. New scenes capture their intensity alongside DMX fixtures.

By default, house dimmers are **independent** of stage master and blackout. Select **Follow stage master and blackout** per fixture to opt in. Connecting, disconnecting, a server restart, and re-establishing a broker connection do not publish stored brightness values. Disconnecting leaves house lights at their current level. Changes made while the broker, bridge, or a known device is offline are not replayed on reconnect; use the dimmer again or recall a scene when it is online.

MQTT publishes changes at up to five commands per second per device, capped at ten per second across an adapter, with the latest fader value replacing intermediate steps. Commands are QoS 0 and never retained. Fades therefore use a lower update rate than DMX and are intended for house-light cues rather than tightly synchronized effects. Zigbee groups can control several lights with one command.

Reported state updates let the app follow changes made by Home Assistant or wall controls, without echoing commands. Reports during a scene fade or within 1.5 seconds of our own command update the reported value but do not move the fader, avoiding transition jitter. Availability shows when Zigbee2MQTT publishes it; otherwise device availability remains unknown. Feedback is what Zigbee2MQTT reports, not an independent measurement of the lamp.

The broker password is saved only in the server’s settings file (mode `0600`) and omitted from browser state updates. An empty password field keeps the saved value; **Clear saved password** removes it. Use the controller on the trusted network described below. The MQTT connection supports normal `mqtt://` and certificate-verified `mqtts://`; no Zigbee device or real installation has been exercised yet. Integration tests use a local MQTT broker.

## Raspberry Pi deployment

The lightweight server and static frontend are designed for a Pi 3 or 4 with Raspberry Pi OS Lite, preferably 64-bit, and Node.js 22+. The runtime dependencies are `ws` and `mqtt`, with no native Node modules or GUI requirement. OLA is only required for USB. Real Pi performance and the physical lights/dongle still need hardware testing; automated verification runs on Linux x64.

Copy this project to `/home/<your-user>/dmxcontrol`, run `npm ci --omit=dev`, and install the included service template. Edit `ExecStart` if Node is not installed at `/usr/bin/node`.

```sh
mkdir -p "$HOME/.local/share/dmxcontrol"
sudo cp deploy/dmxcontrol@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now "dmxcontrol@$USER"
journalctl -u "dmxcontrol@$USER" -f
```

The service stores settings under `~/.local/share/dmxcontrol`. To migrate local settings, stop the service and copy `data/state.json` to `~/.local/share/dmxcontrol/state.json`, owned by your user, before starting it again.

Outputs always start disconnected after a restart. Connecting a DMX adapter starts stage blackout so restoring levels is an explicit action. A graceful shutdown attempts to send a final DMX blackout; MQTT house lights are left unchanged. Abrupt power loss or hardware failure cannot guarantee that, and some fixtures/dongles hold their last levels.

Environment options:

```sh
PORT=3000 HOST=0.0.0.0 DMX_DATA_DIR=/path/to/settings npm start
```

Use a trusted local network: this small controller has no login system. It rejects cross-origin browser WebSocket connections, but any client with direct network access can control it. Do not expose the control server directly to the public internet.

## Verification

```sh
npm test
```

Tests cover profile mapping, RGB/dedicated dimmer scaling, blackout, validation, atomic edits, scene interpolation, real loopback UDP packets and termination, OLA requests/errors/backpressure, ArtDmx headers/addressing/sequence rollover, real Art-Net UDP transmission and final blackout, simultaneous isolated Art-Net and sACN universes, adapter assignments and shared-address routing, legacy migration, multi-client synchronization, cross-origin rejection, and persisted state recovery after a process restart. MQTT tests cover broker authentication, credential masking, brightness commands, state feedback without command loops, rate limiting, availability, reconnects without stale commands, and shared scenes. Browser checks cover touch controls, arrangement, custom profiles, patch validation, scene saving, output failures, and responsive tablet/phone layouts. No physical fixture or dongle has been exercised yet.
