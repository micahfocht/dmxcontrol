export function multicastAddress(universe) {
  return `239.255.${universe >> 8}.${universe & 255}`;
}

// ArtDmx: 18-byte header followed by DMX slots, without a DMX start code.
export function artnetPacket({ universe, sequence = 1 }, slots) {
  if (!Number.isInteger(universe) || universe < 0 || universe > 32767) throw new Error('Art-Net port-address must be 0–32767.');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 255) throw new Error('Art-Net sequence must be 0–255.');
  if (slots.length !== 512) throw new Error('Expected 512 DMX slots.');
  const packet = Buffer.alloc(530);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = sequence;
  packet[14] = universe & 255;
  packet[15] = (universe >> 8) & 127;
  packet.writeUInt16BE(512, 16);
  slots.copy(packet, 18);
  return packet;
}

// E1.31 data packet: ACN root, framing, DMP, start code, 512 DMX slots.
export function sacnPacket({ cid, universe, priority = 100, sequence = 0, terminated = false }, slots) {
  if (slots.length !== 512) throw new Error('Expected 512 DMX slots.');
  const packet = Buffer.alloc(638);
  packet.writeUInt16BE(0x10, 0);
  packet.write('ASC-E1.17\0\0\0', 4, 'ascii');
  packet.writeUInt16BE(0x7000 | 622, 16);
  packet.writeUInt32BE(4, 18);
  Buffer.from(cid.replaceAll('-', ''), 'hex').copy(packet, 22);
  packet.writeUInt16BE(0x7000 | 600, 38);
  packet.writeUInt32BE(2, 40);
  packet.write('DMX Control', 44, 'utf8');
  packet[108] = priority;
  packet[111] = sequence & 255;
  packet[112] = terminated ? 0x40 : 0;
  packet.writeUInt16BE(universe, 113);
  packet.writeUInt16BE(0x7000 | 523, 115);
  packet[117] = 2;
  packet[118] = 0xa1;
  packet.writeUInt16BE(1, 121);
  packet.writeUInt16BE(513, 123);
  slots.copy(packet, 126);
  return packet;
}
