/**
 * Inställningarna (`SVC_TRANSCRIBE_…`) och igenkänningen av ljud: typ, längd och uppskattad längd.
 */
import { describe, expect, it } from 'vitest';
import { BERGET_MAX_FILE_BYTES, readConfig } from '../src/konfig.ts';
import { ASSUMED_BYTES_PER_SECOND, detectAudio, estimateSeconds } from '../src/ljud.ts';
import { mp3, mp4, wav, webm } from './hjalp.ts';

describe('readConfig', () => {
  it('har rimliga standardvärden, med KB-Whisper som modell', () => {
    const c = readConfig({});
    expect(c.model).toBe('KBLab/kb-whisper-large');
    expect(c.concurrency).toBe(2);
    expect(c.retentionDays).toBe(7);
    expect(c.minutesPerAppDay).toBe(120);
    expect(c.maxFileBytes).toBe(BERGET_MAX_FILE_BYTES);
  });

  it('läser egna värden', () => {
    const c = readConfig({
      SVC_TRANSCRIBE_MODEL: 'openai/whisper-large-v3',
      SVC_TRANSCRIBE_CONCURRENCY: '4',
      SVC_TRANSCRIBE_RETENTION_DAYS: '30',
      SVC_TRANSCRIBE_MINUTES_PER_APP_DAY: '15',
      SVC_TRANSCRIBE_MAX_FILE_BYTES: '1000',
      SVC_TRANSCRIBE_TIMEOUT_SECONDS: '60',
    });
    expect(c).toMatchObject({ model: 'openai/whisper-large-v3', concurrency: 4, retentionDays: 30, minutesPerAppDay: 15, maxFileBytes: 1000, timeoutMs: 60_000 });
  });

  it.each([
    ['SVC_TRANSCRIBE_CONCURRENCY', '0'],
    ['SVC_TRANSCRIBE_CONCURRENCY', '1.5'],
    ['SVC_TRANSCRIBE_CONCURRENCY', 'två'],
    ['SVC_TRANSCRIBE_RETENTION_DAYS', '0'],
    ['SVC_TRANSCRIBE_MINUTES_PER_APP_DAY', '-1'],
    ['SVC_TRANSCRIBE_MINUTES_PER_APP_DAY', '1e3'],
    ['SVC_TRANSCRIBE_MAX_FILE_BYTES', String(BERGET_MAX_FILE_BYTES + 1)],
    ['SVC_TRANSCRIBE_TIMEOUT_SECONDS', '0'],
    ['SVC_TRANSCRIBE_MODEL', ''],
    ['SVC_TRANSCRIBE_MODEL', 'modell med mellanslag'],
    ['SVC_TRANSCRIBE_MODEL', 'a\u0000b'],
  ])('%s=%j kastar med klarspråk som namnger variabeln', (namn, varde) => {
    expect(() => readConfig({ [namn]: varde })).toThrow(namn);
  });
});

describe('detectAudio', () => {
  it.each([
    ['audio/mpeg', mp3(100), 'mp3'],
    ['audio/mp3', mp3(100), 'mp3'],
    ['audio/wav', wav(1), 'wav'],
    ['audio/x-wav', wav(1), 'wav'],
    ['audio/webm;codecs=opus', webm(100), 'webm'],
    ['video/webm', webm(100), 'webm'],
    ['audio/mp4', mp4(100), 'mp4'],
    ['audio/x-m4a', mp4(100), 'mp4'],
    ['AUDIO/MPEG', mp3(100), 'mp3'],
  ])('%s med rätt innehåll känns igen som %s', (typ, body, format) => {
    expect(detectAudio(typ, body)?.format).toBe(format);
  });

  it.each([
    ['application/pdf', new Uint8Array(Buffer.from('%PDF-1.7 ...'))],
    ['text/plain', mp3(100)],
    ['image/png', mp3(100)],
    ['audio/ogg', mp3(100)],
    ['', mp3(100)],
    // Rätt typ, fel innehåll: en pdf som påstår sig vara ljud.
    ['audio/mpeg', new Uint8Array(Buffer.from('%PDF-1.7 ...'))],
    ['audio/wav', mp3(100)],
    ['audio/webm', new Uint8Array(0)],
    ['audio/mpeg\u0000', mp3(100)],
  ])('%j avvisas', (typ, body) => {
    expect(detectAudio(typ, body)).toBeNull();
  });
});

describe('estimateSeconds', () => {
  it('läser den exakta längden ur en WAV', () => {
    expect(estimateSeconds('wav', wav(300))).toBe(300);
    expect(estimateSeconds('wav', wav(2.2))).toBe(3); // avrundas uppåt
  });

  it('en WAV som påstår sig vara längre än den är räknas på det som faktiskt finns', () => {
    const kort = wav(10);
    Buffer.from(kort.buffer).writeUInt32LE(0xffffffff, 40);
    expect(estimateSeconds('wav', kort)).toBe(10);
  });

  it('annat ljud uppskattas ur storleken, och aldrig till noll', () => {
    expect(estimateSeconds('mp3', mp3(ASSUMED_BYTES_PER_SECOND * 60))).toBe(60);
    expect(estimateSeconds('webm', webm(10))).toBe(1);
  });
});
