import { expect } from '@playwright/test';
import type {
  EffectPresetResponse,
  GenerationRequest,
  HistoryResponse,
  ModelStatus,
  VoiceProfileResponse,
} from '../app/src/lib/api/types';
import { API_URL, capture, sampleAudio, test } from './fixtures';

const deliveryTest = test.extend<{ recordedVoice: VoiceProfileResponse }>({
  recordedVoice: [
    async ({ request }, use) => {
      const response = await request.post(`${API_URL}/profiles`, {
        data: {
          name: 'Campaign Narrator',
          language: 'en',
          voice_type: 'cloned',
          default_engine: 'qwen',
        },
      });
      await expect(response).toBeOK();
      const voice: VoiceProfileResponse = await response.json();
      try {
        await expect(
          await request.post(`${API_URL}/profiles/${voice.id}/samples`, {
            multipart: {
              reference_text: 'This is a narration sample.',
              file: { name: 'sample.wav', mimeType: 'audio/wav', buffer: sampleAudio() },
            },
          }),
        ).toBeOK();
        await use(voice);
      } finally {
        await expect(await request.delete(`${API_URL}/profiles/${voice.id}`)).toBeOK();
      }
    },
    { timeout: 30_000 },
  ],
});

deliveryTest(
  'preview, compare, and save the delivery for a recorded voice',
  async ({ page, request, voice, recordedVoice }) => {
    const presets = await request.get(`${API_URL}/effects/presets`);
    await expect(presets).toBeOK();
    const narration: EffectPresetResponse | undefined = (await presets.json()).find(
      (preset: EffectPresetResponse) => preset.name === 'YouTube Narration' && preset.is_builtin,
    );
    expect(narration).toBeDefined();

    let downloaded = false;
    let modelLoads = 0;
    let completedTake: HistoryResponse | undefined;
    const previews: GenerationRequest[] = [];
    const generations: GenerationRequest[] = [];
    await page.route(`${API_URL}/models/status`, async (route) => {
      const live = await route.fetch();
      const data = await live.json();
      const chatterbox = data.models.find(
        (model: ModelStatus) => model.model_name === 'chatterbox-tts',
      );
      expect(chatterbox).toBeDefined();
      chatterbox.downloaded = downloaded;
      await route.fulfill({ response: live, json: data });
    });
    await page.route(`${API_URL}/models/load`, (route) => {
      expect(route.request().postDataJSON()).toEqual({ model_name: 'chatterbox-tts' });
      modelLoads++;
      downloaded = true;
      return route.fulfill({ json: { message: 'Model loaded' } });
    });
    await page.route(`${API_URL}/generate/stream`, (route) => {
      expect(downloaded).toBe(true);
      previews.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'audio/wav', body: sampleAudio() });
    });
    await page.route(`${API_URL}/generate`, (route) => {
      const take: GenerationRequest = route.request().postDataJSON();
      generations.push(take);
      completedTake = {
        ...take,
        id: 'campaign-take',
        profile_name: recordedVoice.name,
        status: 'completed',
        created_at: new Date().toISOString(),
        duration: 2,
      };
      return route.fulfill({ json: completedTake });
    });
    await page.route(`${API_URL}/history?*`, (route) =>
      route.fulfill({
        json: { items: completedTake ? [completedTake] : [], total: completedTake ? 1 : 0 },
      }),
    );
    await page.route(`${API_URL}/audio/campaign-take`, (route) =>
      route.fulfill({ contentType: 'audio/wav', body: sampleAudio() }),
    );
    await page.route(`${API_URL}/generate/campaign-take/status`, (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"id":"campaign-take","status":"completed"}\n\n',
      }),
    );
    await page.addInitScript(() => {
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        const data = document.documentElement.dataset;
        data.previewPlays = String(Number(data.previewPlays ?? '0') + 1);
        return start.apply(this, args);
      };
    });

    const script = 'Meet the easier way to make your first video. Try it today.';
    const pickVoice = async (name: string) => {
      await page.getByRole('combobox', { name: 'Voice', exact: true }).click();
      await page.getByRole('option', { name: `${name} · en`, exact: true }).click();
    };
    const delivery = page.getByRole('group', { name: 'Delivery', exact: true });
    const natural = delivery.getByRole('button', { name: 'Natural', exact: true });
    const upbeat = delivery.getByRole('button', { name: 'Upbeat', exact: true });
    const excited = delivery.getByRole('button', { name: 'Excited', exact: true });
    const draft = page.getByRole('textbox', { name: 'Script', exact: true });
    const polish = page.getByRole('switch', { name: 'Voiceover polish', exact: true });
    const effects = page.getByRole('combobox', { name: 'Effects', exact: true });
    const hear = page.getByRole('button', { name: 'Hear it', exact: true });
    const hearNatural = page.getByRole('button', { name: 'Hear Natural', exact: true });
    const save = page.getByRole('button', { name: 'Save for this voice', exact: true });
    const saved = page.getByRole('button', { name: 'Saved for this voice', exact: true });

    await page.goto('/');
    await pickVoice(recordedVoice.name);
    await expect(natural).toHaveAttribute('aria-pressed', 'true');
    await draft.fill(script);
    await upbeat.click();
    await expect(upbeat).toHaveAttribute('aria-pressed', 'true');
    await effects.click();
    await page.getByRole('option', { name: 'Echo Chamber', exact: true }).click();
    await polish.click();
    await expect(polish).toHaveAttribute('aria-checked', 'true');
    await expect(effects).toContainText('YouTube Narration');
    await polish.click();
    await expect(effects).toContainText('Echo Chamber');
    await polish.click();

    await page.getByRole('button', { name: 'Download & hear', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-preview-plays', '1');
    await hearNatural.click();
    await expect(page.locator('html')).toHaveAttribute('data-preview-plays', '2');
    await expect(hear).toBeVisible();
    expect(modelLoads).toBe(1);
    expect(previews).toHaveLength(2);
    expect(previews[0]).toMatchObject({
      profile_id: recordedVoice.id,
      text: 'Meet the easier way to make your first video.',
      engine: 'chatterbox',
      effects_chain: narration!.effects_chain,
      chatterbox_cfg_weight: 0.3,
      chatterbox_exaggeration: 0.7,
    });
    const { chatterbox_cfg_weight, chatterbox_exaggeration, ...naturalRequest } = previews[0];
    expect(previews[1]).toEqual(naturalRequest);
    expect(generations).toHaveLength(0);
    await expect(draft).toHaveValue(script);
    await page.getByRole('button', { name: 'Stop comparison', exact: true }).click();
    await capture(page, 'delivery-desktop');

    await page.getByRole('button', { name: /^Speech settings/ }).click();
    const expression = page.getByRole('spinbutton', { name: 'Expression' });
    await expect(expression).toBeHidden();
    await page.getByText('Advanced delivery', { exact: true }).click();
    await expect(expression).toHaveValue('0.7');
    await page.keyboard.press('Escape');

    await excited.click();
    await save.click();
    await expect(saved).toBeDisabled();
    await page.reload();
    await pickVoice(voice.name);
    await expect(delivery).toHaveCount(0);
    await expect(polish).toHaveAttribute('aria-checked', 'false');
    await pickVoice(recordedVoice.name);
    await expect(excited).toHaveAttribute('aria-pressed', 'true');
    await expect(polish).toHaveAttribute('aria-checked', 'true');
    await expect(saved).toBeDisabled();

    await page.setViewportSize({ width: 390, height: 844 });
    await draft.fill(script);
    await expect(excited).toBeInViewport({ ratio: 1 });
    await expect(hear).toBeInViewport({ ratio: 1 });
    await expect(hearNatural).toBeInViewport({ ratio: 1 });
    await draft.blur();
    await capture(page, 'delivery-phone');
    await hear.click();
    await expect(page.locator('html')).toHaveAttribute('data-preview-plays', '1');
    await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
    await page.getByRole('button', { name: 'Generate speech', exact: true }).click();
    await expect.poll(() => generations.length).toBe(1);
    expect(generations[0]).toMatchObject({
      ...naturalRequest,
      text: script,
      chatterbox_cfg_weight: 0.3,
      chatterbox_exaggeration: 0.8,
    });
    await expect(draft).toHaveValue('');
    await expect(
      page.getByRole('region', { name: 'Recent takes' }).getByText(script, { exact: true }),
    ).toBeVisible();
  },
);
