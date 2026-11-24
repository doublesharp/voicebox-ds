import path from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { VoiceProfileResponse } from '../app/src/lib/api/types';

export const API_URL = process.env.VOICEBOX_E2E_API_URL || '';
const outputDir = process.env.VOICEBOX_E2E_OUTPUT_DIR;

export const test = base.extend<{ voice: VoiceProfileResponse }>({
  page: async ({ page, request }, use) => {
    const allowed = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;
    if (!allowed.test(API_URL)) {
      throw new Error('Set VOICEBOX_E2E_API_URL to a disposable local Voicebox backend.');
    }
    const health = await request.get(`${API_URL}/health`);
    await expect(health).toBeOK();
    expect(health.headers()['x-voicebox-application']).toBe('com.doublesharp.voicebox.ds');
    expect(await health.json()).toMatchObject({ status: 'healthy' });
    await page.addInitScript((serverUrl) => {
      localStorage.setItem(
        'voicebox-server',
        JSON.stringify({ state: { serverUrl, serverUrlSource: 'custom' }, version: 2 }),
      );
    }, API_URL);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.url().startsWith(`${API_URL}/`) && response.status() >= 400) {
        const request = response.request();
        errors.push(
          `${request.method()} ${new URL(response.url()).pathname}: ${response.status()}`,
        );
      }
    });
    await use(page);
    expect(errors, 'application exceptions or failed API responses').toEqual([]);
  },
  voice: async ({ request }, use) => {
    const voice = await createVoice(request, 'Harbor Narrator');
    try {
      await use(voice);
    } finally {
      await expect(await request.delete(`${API_URL}/profiles/${voice.id}`)).toBeOK();
    }
  },
});

export async function createVoice(request: APIRequestContext, name: string) {
  const response = await request.post(`${API_URL}/profiles`, {
    data: {
      name,
      description: 'Warm, clear narration',
      language: 'en',
      voice_type: 'preset',
      preset_engine: 'kokoro',
      preset_voice_id: 'af_heart',
      default_engine: 'kokoro',
    },
  });
  await expect(response).toBeOK();
  return (await response.json()) as VoiceProfileResponse;
}

export function navigation(page: Page, name: string) {
  return page.getByRole('link', { name, exact: true }).filter({ visible: true }).first();
}

export async function capture(page: Page, name: string) {
  if (outputDir) {
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: path.join(outputDir, `${name}.png`),
      animations: 'disabled',
    });
  }
}

export function sampleAudio() {
  const sampleRate = 16000;
  const samples = sampleRate * 2;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    wave.writeInt16LE(Math.round(1600 * Math.sin((i / sampleRate) * Math.PI * 440)), 44 + i * 2);
  }
  return wave;
}
