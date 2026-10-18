import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Entrada de áudio determinística só para testes; o transporte WebRTC é o real.
export function createAudioFixture() {
  const rate = 48000;
  const samples = rate * 4;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 10000),
      44 + index * 2,
    );
  const path = join(tmpdir(), `conversa-tone-${process.pid}.wav`);
  writeFileSync(path, data);
  return path;
}
