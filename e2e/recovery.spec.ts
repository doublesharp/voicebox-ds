import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { HistoryResponse } from '../app/src/lib/api/types';
import { API_URL, capture, sampleAudio, test } from './fixtures';

test('request the microphone on demand and retry a denied recording', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const root = document.documentElement;
      root.dataset.microphoneRequests = String(Number(root.dataset.microphoneRequests ?? 0) + 1);
      if (root.dataset.microphonePermission !== 'granted') {
        throw new DOMException('Permission denied', 'NotAllowedError');
      }
      // Feed a synthetic input to the browser's real MediaRecorder.
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const tone = context.createOscillator();
      tone.connect(destination);
      tone.start();
      const track = destination.stream.getAudioTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        tone.stop();
        void context.close();
        root.dataset.microphoneReleased = 'true';
      };
      return destination.stream;
    };
  });

  await page.goto('/voices');
  await page.getByRole('button', { name: 'New Voice' }).click();
  const dialog = page.getByRole('dialog');
  const start = dialog.getByRole('button', { name: 'Start Recording' });
  await expect(start).toBeVisible();
  const requests = () =>
    page.locator('html').evaluate((root) => Number(root.dataset.microphoneRequests ?? 0));
  expect(await requests()).toBe(0);

  await start.click();
  expect(await requests()).toBe(1);
  const recovery = dialog.getByRole('alert').filter({ hasText: /site settings.*try again/i });
  await expect(recovery).toBeVisible();
  await capture(page, '01-microphone-permission');

  await page.locator('html').evaluate((root) => {
    root.dataset.microphonePermission = 'granted';
  });
  await start.click();
  await expect(recovery).toHaveCount(0);
  await expect(dialog.getByText(/^0:(?:0[1-9]|[12]\d)$/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop Recording' }).click();
  await expect(dialog.getByText('Recording complete', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-microphone-released', 'true');
});

test('retry a failed take once and keep its original text', async ({ page, voice }) => {
  const take: HistoryResponse = {
    id: 'harbor-retry',
    text: 'The overnight crossing is canceled.',
    profile_id: voice.id,
    profile_name: voice.name,
    language: 'en',
    duration: 0,
    engine: 'kokoro',
    model_size: '82M',
    status: 'failed',
    error: 'The model was unavailable.',
    is_favorited: false,
    created_at: new Date().toISOString(),
  };
  let finishRetry!: () => void;
  const acceptingRetry = new Promise<void>((resolve) => {
    finishRetry = resolve;
  });
  let retryRequests = 0;
  await page.route(`${API_URL}/history?*`, (route) =>
    route.fulfill({ json: { items: [take], total: 1 } }),
  );
  await page.route(`${API_URL}/generate/${take.id}/retry`, async (route) => {
    expect(route.request().method()).toBe('POST');
    retryRequests++;
    await acceptingRetry;
    take.status = 'generating';
    await route.fulfill({ json: take });
  });
  await page.route(`${API_URL}/generate/${take.id}/status`, async (route) => {
    take.status = 'completed';
    take.duration = 2;
    delete take.error;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(take)}\n\n`,
    });
  });
  await page.route(`${API_URL}/audio/*`, (route) =>
    route.fulfill({ body: sampleAudio(), contentType: 'audio/wav' }),
  );

  try {
    await page.goto('/');
    const retry = page.getByRole('button', { name: 'Retry generation' });
    await expect(retry).toBeVisible();
    await capture(page, '04-retry-failed-take');
    await retry.click();
    await expect.poll(() => retryRequests).toBe(1);
    await expect(retry).toBeDisabled();
    finishRetry();
    await expect(page.getByText(take.text, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play take', exact: true })).toBeVisible();
    expect(retryRequests).toBe(1);
  } finally {
    finishRetry();
  }
});

test('reject an empty voice design and keep a valid edit after reopening', async ({
  page,
  request,
}) => {
  const name = 'Harbor Voice Design';
  const original = 'A warm speaking voice with a moderate pace.';
  const revised = 'A quiet alto with a quick, steady pace.';
  const create = await request.post(`${API_URL}/profiles`, {
    data: {
      name,
      language: 'en',
      voice_type: 'designed',
      default_engine: 'qwen_voice_design',
      design_prompt: original,
    },
  });
  await expect(create).toBeOK();
  const { id } = await create.json();
  const profile = `${API_URL}/profiles/${id}`;

  try {
    await page.goto('/voices');
    const open = () => page.getByRole('button', { name, exact: true }).click();
    await open();
    const prompt = page.getByRole('textbox', { name: 'Voice Description' });
    const save = page.getByRole('button', { name: /^Save( changes)?$/i });
    await expect(prompt).toHaveValue(original);
    await prompt.fill('   ');
    await save.click();
    await expect(prompt).toHaveAttribute('aria-invalid', 'true');
    await expect(prompt).toHaveAccessibleDescription('Describe the voice.');
    expect(await (await request.get(profile)).json()).toMatchObject({ design_prompt: original });

    await prompt.fill(`  ${revised}  `);
    await save.click();
    await expect(prompt).toHaveValue(revised);
    await expect(prompt).toHaveAttribute('aria-invalid', 'false');
    await page.reload();
    await open();
    await expect(prompt).toHaveValue(revised);
    await capture(page, '02-saved-voice-design');
  } finally {
    await expect(await request.delete(profile)).toBeOK();
  }
});

test('open a Story on a phone, import a clip, and download the audio', async ({
  page,
  request,
}) => {
  const name = 'Harbor Field Recordings';
  const create = await request.post(`${API_URL}/stories`, { data: { name } });
  await expect(create).toBeOK();
  const { id } = await create.json();
  const story = `${API_URL}/stories/${id}`;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/stories');
    const search = page.getByRole('textbox', { name: 'Search stories…' });
    await search.fill('Field Recordings');
    const result = page.getByRole('button', { name: new RegExp(`^Story ${name},`) });
    await result.click();
    const back = page.getByRole('button', { name: 'Back to stories' });
    await expect(back).toBeFocused();
    await expect(page.getByRole('heading', { name })).toBeInViewport({ ratio: 1 });
    const generate = page.getByRole('button', { name: 'Generate', exact: true });
    await generate.click();
    await expect(page.getByRole('textbox', { name: 'Script', exact: true })).toBeInViewport();
    await generate.click();
    const file = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import audio…', exact: true }).click();
    await (await file).setFiles({
      name: 'Harbor tone.wav',
      mimeType: 'audio/wav',
      buffer: sampleAudio(),
    });
    const exportAudio = page.getByRole('button', { name: 'Export Audio', exact: true });
    await expect(exportAudio).toBeInViewport({ ratio: 1 });
    expect(await (await request.get(story)).json()).toMatchObject({
      items: [expect.objectContaining({ generation_id: expect.any(String) })],
    });
    await capture(page, '03-story-phone');
    await exportAudio.click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Audio (WAV)' }).click();
    const wav = await download;
    expect(wav.suggestedFilename()).toMatch(/\.wav$/);
    expect((await readFile(await wav.path())).subarray(0, 4).toString()).toBe('RIFF');

    await back.click();
    await expect(search).toHaveValue('Field Recordings');
    await expect(search).toBeFocused();
    await result.click();
    await expect(exportAudio).toBeInViewport({ ratio: 1 });
  } finally {
    await expect(await request.delete(story)).toBeOK();
  }
});
