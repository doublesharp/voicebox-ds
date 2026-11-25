import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { CaptureResponse, HistoryResponse } from '../app/src/lib/api/types';
import { API_URL, capture, navigation, sampleAudio, test } from './fixtures';

for (const { retry, title } of [
  { retry: false, title: 'finish first-run setup with a built-in voice and a playable take' },
  { retry: true, title: 'retry first-run setup on a phone without adding a second voice' },
]) {
  test(title, async ({ page, request }) => {
    const profilesUrl = `${API_URL}/profiles`;
    expect(await (await request.get(profilesUrl)).json()).toEqual([]);
    if (retry) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark' });
    }
    let createdProfileId: string | undefined;
    let take: HistoryResponse | undefined;
    let generationRequests = 0;
    let sampleFinished = false;
    let finishSample = () => {};
    const waitForSample = new Promise<void>((resolve) => {
      finishSample = () => {
        sampleFinished = true;
        resolve();
      };
    });
    await page.route(`${API_URL}/models/status`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const model = data.models.find(
        (entry: { model_name: string }) => entry.model_name === 'kokoro',
      );
      expect(model).toBeDefined();
      model.downloaded = true;
      await route.fulfill({ response, json: data });
    });
    await page.route(profilesUrl, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      await expect(response).toBeOK();
      createdProfileId = (await response.json()).id;
      await route.fulfill({ response });
    });
    await page.route(`${API_URL}/history?*`, (route) =>
      route.fulfill({ json: { items: take ? [take] : [], total: take ? 1 : 0 } }),
    );
    await page.route(`${API_URL}/generate`, async (route) => {
      generationRequests += 1;
      if (retry && generationRequests === 1) return route.abort();
      const { profile_id, text, engine, language } = route.request().postDataJSON();
      expect({ engine, language }).toEqual({ engine: 'kokoro', language: 'en' });
      expect(text.length).toBeGreaterThan(5);
      const profiles = await (await request.get(profilesUrl)).json();
      expect(profiles).toEqual([
        expect.objectContaining({ id: profile_id, voice_type: 'preset', preset_engine: 'kokoro' }),
      ]);
      take = {
        id: 'first-take',
        text,
        profile_id,
        profile_name: profiles[0].name,
        engine,
        language,
        duration: 2,
        model_size: '82M',
        status: 'completed',
        is_favorited: false,
        created_at: new Date().toISOString(),
      };
      await route.fulfill({ json: { ...take, status: 'generating' } });
    });
    await page.route(`${API_URL}/history/first-take`, (route) =>
      route.fulfill({ json: { ...take, status: sampleFinished ? 'completed' : 'generating' } }),
    );
    await page.route(`${API_URL}/generate/first-take/status`, async (route) => {
      await waitForSample;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify(take)}\n\n`,
      });
    });
    await page.route(`${API_URL}/audio/first-take`, (route) =>
      route.fulfill({ body: sampleAudio(), contentType: 'audio/wav' }),
    );
    await page.route(`${API_URL}/settings/generation`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), autoplay_on_generate: false },
      });
    });

    try {
      const settings = page.waitForResponse(`${API_URL}/settings/generation`);
      await page.goto('/');
      expect((await settings).ok()).toBe(true);
      const step = page
        .getByRole('list', { name: 'First run steps' })
        .locator('[aria-current="step"]');
      await expect(page.getByRole('heading', { name: 'Make your first take' })).toBeVisible();
      await expect(step).toContainText('Voice setup');
      await expect(page.getByRole('region', { name: 'Recent takes' })).toBeHidden();
      const start = page.getByRole('button', { name: 'Generate sample', exact: true });
      await expect(start).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: /^Create Voice/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Import Voice/ })).toBeVisible();
      await capture(page, retry ? '01-choose-voice-phone' : '01-choose-voice-desktop');
      await start.click();
      await expect(step).toContainText('First take');
      await expect(page.getByRole('heading', { name: 'Hear your first take' })).toBeFocused();
      if (retry) {
        const failed = page.getByText('Couldn’t prepare the sample', { exact: true });
        await expect(failed).toBeVisible();
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(failed).toBeHidden();
      }
      await expect(page.getByText('Preparing your sample…', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Play sample', exact: true })).toBeHidden();
      if (!retry) await capture(page, '02-preparing-take-desktop');
      finishSample();

      const play = page.getByRole('button', { name: 'Play sample', exact: true });
      await expect(play).toBeInViewport({ ratio: 1 });
      const audio = page.waitForResponse(`${API_URL}/audio/first-take`);
      await play.click();
      expect((await audio).ok()).toBe(true);
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      await capture(page, retry ? '03-first-take-phone' : '03-first-take-desktop');

      await page.getByRole('button', { name: 'Open Generate', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Script', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Recent takes' })).toBeVisible();
      await expect(step).toBeHidden();
      await page.reload();
      await expect(page.getByRole('textbox', { name: 'Script', exact: true })).toBeVisible();
      await expect(step).toBeHidden();
      expect(generationRequests).toBe(retry ? 2 : 1);
    } finally {
      finishSample();
      if (createdProfileId) {
        await expect(await request.delete(`${profilesUrl}/${createdProfileId}`)).toBeOK();
      }
    }
  });
}

test('first-run setup opens Create Voice and Import Voice directly', async ({ page, request }) => {
  expect(await (await request.get(`${API_URL}/profiles`)).json()).toEqual([]);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make your first take' })).toBeVisible();
  await page.getByRole('button', { name: /^Create Voice/ }).click();
  const voiceForm = page.getByRole('dialog');
  await expect(voiceForm.getByRole('button', { name: /Built-in/i })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(voiceForm).toBeHidden();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Import Voice/ }).click();
  const input = (await chooser).element();
  expect(await input.getAttribute('accept')).toBe('.voicebox.zip');
  expect(await (await request.get(`${API_URL}/profiles`)).json()).toEqual([]);
});

test('create a project from a script and reopen the saved edit', async ({ page }) => {
  await page.goto('/');
  await navigation(page, 'Projects').click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog');
  const name = 'Harbor Dispatch';
  await dialog.getByLabel('Project name').fill(name);
  await dialog
    .getByLabel('Script', { exact: true })
    .fill('At first light, the harbor was still.\n\nThe ferries started running at seven.');
  await capture(page, '02-new-project');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/projects\/[^/]+\/edit$/);
  const text = page.getByRole('textbox', { name: 'Passage 2 text' });
  await expect(text).toHaveValue('The ferries started running at seven.');
  await text.fill('The ferries started running just after seven.');
  await text.press('Tab');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await capture(page, '03-project-edit');
  await page.reload();
  await expect(text).toHaveValue('The ferries started running just after seven.');
  await page
    .getByRole('navigation', { name: 'Project workspace' })
    .getByRole('link', { name: /Mix/i })
    .click();
  await expect(page).toHaveURL(/\/mix$/);
  await expect(
    page.getByRole('navigation', { name: 'Project workspace' }).getByRole('link', { name: /Mix/i }),
  ).toHaveAttribute('aria-current', 'page');
  await capture(page, '04-project-mix');
  await navigation(page, 'Projects').click();
  const search = page.getByRole('textbox', { name: 'Search projects' });
  await search.fill(name);
  const savedProject = page
    .getByRole('link', { name: new RegExp(name) })
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(savedProject.first()).toBeVisible();
  await capture(page, '01-projects');
});

test('create and find a built-in voice without a microphone', async ({ page, request }) => {
  const name = 'Harbor Host';
  try {
    await page.goto('/voices');
    await page.getByRole('button', { name: 'New Voice' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /Built-in/i }).click();
    await dialog.getByRole('button', { name: /Heart/ }).click();
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await capture(page, '05-create-voice');
    await dialog.getByRole('button', { name: /Create/ }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('textbox', { name: 'Search voices…' }).fill(name);
    const voice = page.getByRole('button', { name, exact: true });
    await voice.click();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
    await capture(page, '06-voice-inspector');
  } finally {
    const profiles = await (await request.get(`${API_URL}/profiles`)).json();
    const created = profiles.find((profile: { name: string }) => profile.name === name);
    if (created) await expect(await request.delete(`${API_URL}/profiles/${created.id}`)).toBeOK();
  }
});

test('generate a take, play it, and favorite it from Recent takes', async ({ page, voice }) => {
  const script = 'This is Harbor Radio. The morning ferry leaves at seven.';
  const previousScript = 'Welcome to the morning report from Harbor Radio.';
  const createdAt = new Date().toISOString();
  const take = (id: string, text: string): HistoryResponse => ({
    id,
    text,
    profile_id: voice.id,
    profile_name: voice.name,
    language: 'en',
    duration: 2,
    engine: 'kokoro',
    model_size: '82M',
    status: 'completed',
    is_favorited: false,
    created_at: createdAt,
  });
  const history = [take('previous-take', previousScript)];
  await page.route(`${API_URL}/models/status`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const model = data.models.find(
      (model: { model_name: string }) => model.model_name === 'kokoro',
    );
    expect(model).toBeDefined();
    model.downloaded = true;
    await route.fulfill({ response, json: data });
  });
  await page.route(`${API_URL}/history?*`, (route) =>
    route.fulfill({ json: { items: history, total: history.length } }),
  );
  await page.route(`${API_URL}/generate`, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      text: script,
      profile_id: voice.id,
      engine: 'kokoro',
    });
    const result = take('new-take', script);
    history.unshift(result);
    return route.fulfill({ json: result });
  });
  await page.route(`${API_URL}/generate/new-take/status`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(history[0])}\n\n`,
    }),
  );
  await page.route(`${API_URL}/settings/generation`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), autoplay_on_generate: false },
    });
  });
  await page.route(`${API_URL}/audio/*`, (route) =>
    route.fulfill({ body: sampleAudio(), contentType: 'audio/wav' }),
  );
  await page.route(`${API_URL}/history/new-take/favorite`, (route) => {
    history[0].is_favorited = true;
    return route.fulfill({ json: { is_favorited: true } });
  });

  await page.goto('/');
  await expect(page.getByText(previousScript, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Voice', exact: true }).click();
  await page.getByRole('option', { name: /Harbor Narrator/ }).click();
  const input = page.getByRole('textbox', { name: 'Script', exact: true });
  await input.fill(script);
  await capture(page, '07-generate');
  await page.getByRole('button', { name: 'Generate speech', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Recent takes' })
    .locator('[role="button"]')
    .filter({ hasText: script });
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleDescription(script);
  await page.getByRole('button', { name: 'Play take', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Restart playback', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Favorite', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Unfavorite', exact: true })).toBeVisible();
  await capture(page, '08-generated-take');
});

test('find and export a captured transcript on desktop and phone', async ({ page }) => {
  const item: CaptureResponse = {
    id: 'harbor-capture',
    audio_path: 'harbor.wav',
    created_at: new Date().toISOString(),
    source: 'file',
    duration_ms: 2000,
    language: 'en',
    transcript_raw: 'um call the harbor office before lunch',
    transcript_refined: 'Call the harbor office before lunch.',
    stt_model: 'base',
    llm_model: '0.6B',
  };
  await page.route(`${API_URL}/captures?*`, (route) =>
    route.fulfill({ json: { items: [item], total: 1 } }),
  );
  await page.route(`${API_URL}/captures/${item.id}/audio`, (route) =>
    route.fulfill({ body: sampleAudio(), contentType: 'audio/wav' }),
  );
  await page.route(`${API_URL}/capture/readiness`, (route) =>
    route.fulfill({
      json: {
        stt: {
          ready: true,
          model_name: 'whisper-base',
          display_name: 'Whisper Base',
          size: 'Base',
        },
        llm: { ready: true, model_name: 'qwen3-0.6B', display_name: 'Qwen3', size: '0.6B' },
      },
    }),
  );

  await page.goto('/captures');
  await page.getByRole('textbox', { name: 'Search transcripts…' }).fill('harbor');
  await page.getByRole('button', { name: /Call the harbor office/ }).click();
  await expect(page.locator('textarea')).toHaveValue(item.transcript_refined!);
  await capture(page, '09-capture-desktop');
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  await expect(page.locator('textarea')).toHaveValue(item.transcript_raw);
  const downloadCapture = async (label: string) => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    return download;
  };
  const transcriptDownload = await downloadCapture('Transcript (TXT)');
  expect(transcriptDownload.suggestedFilename()).toMatch(/\.txt$/);
  expect((await readFile(await transcriptDownload.path(), 'utf8')).trim()).toBe(
    item.transcript_raw,
  );
  const markdown = await downloadCapture('Markdown (MD)');
  expect(markdown.suggestedFilename()).toMatch(/\.md$/);
  const markdownText = await readFile(await markdown.path(), 'utf8');
  expect(markdownText).toContain(item.transcript_raw);
  expect(markdownText).toContain(item.transcript_refined);
  const audio = await downloadCapture('Audio (WAV)');
  expect(audio.suggestedFilename()).toMatch(/\.wav$/);
  expect(await readFile(await audio.path())).toEqual(sampleAudio());

  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, '10-capture-phone');
  const transcript = page.getByRole('textbox', { name: 'Transcript', exact: true });
  await expect(transcript).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'Back to captures' }).click();
  await expect(page.getByRole('textbox', { name: 'Search transcripts…' })).toHaveValue('harbor');
  await page.getByRole('button', { name: /Call the harbor office/ }).click();
  await expect(transcript).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Back to captures' })).toBeFocused();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await capture(page, '17-capture-phone-dark');
});

test('open the Stories library and find model and capture settings', async ({ page }) => {
  await page.goto('/studio/projects');
  await navigation(page, 'Stories').click();
  await expect(page).toHaveURL(/\/stories$/);
  await expect(page.getByRole('heading', { name: 'Stories', exact: true })).toBeVisible();
  await expect(page.locator('[data-composer-layout]')).toHaveCount(0);
  await capture(page, '11-stories');
  await navigation(page, 'Models').click();
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  const modelSearch = page.getByRole('searchbox', { name: 'Search models…' });
  await modelSearch.fill('Kokoro');
  await expect(page.getByRole('button', { name: /Kokoro 82M/ })).toBeInViewport();
  await expect(page.getByRole('button', { name: /Qwen TTS/ })).toHaveCount(0);
  await modelSearch.fill('unknown model');
  await expect(page.getByRole('status')).toContainText('No matching models');
  await modelSearch.clear();
  await expect(page.getByRole('button', { name: /Qwen TTS 1.7B/ }).first()).toBeInViewport();
  await capture(page, '12-models');
  await page.getByText('Model readiness', { exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: /Loaded speech engines/ })).toBeVisible();
  await navigation(page, 'Settings').click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await expect(page.getByRole('textbox', { name: 'Server URL' })).toBeVisible();
  await capture(page, '13-general-settings');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Captures' })
    .click();
  await expect(page).toHaveURL(/\/settings\/captures$/);
  await expect(page.getByText('Transcription', { exact: true })).toBeVisible();
  await capture(page, '14-capture-settings');
});

test('Stories is one click from Generate', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Stories', exact: true })
    .click({ timeout: 3000 });
  await expect(page).toHaveURL(/\/stories$/);
});

test('copy a Story into Studio with the original still in the library', async ({
  page,
  request,
}) => {
  test.setTimeout(45_000);
  const name = 'Harbor Archive';
  try {
    await page.goto('/');
    await navigation(page, 'Stories').click();
    await page.getByRole('button', { name: 'New Story', exact: true }).click();
    const create = page.getByRole('dialog');
    await create.getByLabel('Name', { exact: true }).fill(name);
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('button', { name: new RegExp(`^Story ${name},`) })).toBeVisible();
    const file = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import audio…', exact: true }).click();
    const chooser = await file;
    const [imported] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${API_URL}/generate/import` && response.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      chooser.setFiles({
        name: 'Harbor archive clip.wav',
        mimeType: 'audio/wav',
        buffer: sampleAudio(),
      }),
    ]);
    expect(imported.ok(), 'The Story audio import succeeded').toBe(true);
    await expect(page.getByRole('button', { name: 'Export Audio', exact: true })).toBeVisible();

    await navigation(page, 'Projects').click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy from Story…' }).click();
    const copy = page.getByRole('dialog', { name: 'Copy from Story' });
    await copy.getByLabel('Story', { exact: true }).selectOption({ label: name });
    await capture(page, '15-copy-story');
    await copy.getByRole('button', { name: 'Create studio copy' }).click();
    await expect(page).toHaveURL(/\/studio\/projects\/[^/]+\/edit$/);
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(name);
    await page
      .getByRole('navigation', { name: 'Project workspace' })
      .getByRole('link', { name: /Mix/i })
      .click();
    await expect(
      page.getByRole('region', { name: 'Timeline' }).getByText('1 clip · 48 kHz stereo'),
    ).toBeVisible();
    await navigation(page, 'Stories').click();
    await expect(page.getByRole('button', { name: new RegExp(`^Story ${name},`) })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export Audio', exact: true })).toBeVisible();
  } finally {
    const response = await request.get(`${API_URL}/stories`);
    await expect(response).toBeOK();
    const stories = await response.json();
    const created = stories.find((story: { name: string }) => story.name === name);
    if (created) await expect(await request.delete(`${API_URL}/stories/${created.id}`)).toBeOK();
  }
});

test('import audio, checkpoint from Deliver, and download a WAV', async ({ page, request }) => {
  const response = await request.post(`${API_URL}/studio/v1/projects`, {
    data: { name: 'Harbor Mix' },
  });
  await expect(response).toBeOK();
  const project = await response.json();
  await page.goto(`/studio/projects/${project.id}/mix`);
  const timeline = page.getByRole('region', { name: 'Timeline', exact: true });
  const file = page.waitForEvent('filechooser');
  await timeline.getByRole('button', { name: 'Import audio', exact: true }).click();
  await (await file).setFiles({
    name: 'Harbor tone.wav',
    mimeType: 'audio/wav',
    buffer: sampleAudio(),
  });
  await expect(timeline.getByText('1 clip · 48 kHz stereo')).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Deliver', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Deliver' })
    .getByRole('button', { name: 'Create checkpoint' })
    .click();
  const checkpoint = page.getByRole('dialog', { name: 'Create a checkpoint' });
  await checkpoint.getByLabel('Checkpoint name').fill('First mix');
  await checkpoint.getByRole('button', { name: 'Create checkpoint' }).click();
  const deliver = page.getByRole('dialog', { name: 'Deliver' });
  await expect(deliver).toBeVisible();
  await expect(deliver.getByLabel('Source checkpoint')).toHaveValue(/.+/);
  await deliver.getByLabel('Processing').selectOption('dry');
  await deliver.getByRole('button', { name: 'Render dry mix' }).click();
  const save = deliver.getByRole('button', { name: 'Save a copy' });
  await expect(save).toBeVisible({ timeout: 10_000 });
  await capture(page, '16-deliver-wav');
  const download = page.waitForEvent('download');
  await save.click();
  const wav = await download;
  expect(wav.suggestedFilename()).toMatch(/\.wav$/);
  const bytes = await readFile(await wav.path());
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
});

test('create an effect preset and reopen it from the phone list', async ({ page, request }) => {
  const name = 'Harbor Level';
  try {
    await page.goto('/');
    await navigation(page, 'Effects').click();
    await page.getByRole('button', { name: 'New Preset', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    const addEffect = page.getByRole('combobox', { name: 'Add effect…' });
    await addEffect.click();
    await page.getByRole('option', { name: 'Gain', exact: true }).click();
    await expect(addEffect).toHaveText('Add effect…');
    await addEffect.click();
    await page.getByRole('option', { name: 'Gain', exact: true }).click();
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) Gain$/ })).toHaveCount(2);
    await page.getByRole('button', { name: 'Save Preset', exact: true }).click();
    await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await capture(page, '18-effects');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Back to presets' }).click();
    await page.getByRole('button', { name: new RegExp(name) }).click();
    const savedName = page.getByRole('textbox', { name: 'Name', exact: true });
    await expect(savedName).toHaveValue(name);
    await expect(savedName).toBeInViewport({ ratio: 1 });
    await capture(page, '19-effects-phone');
  } finally {
    const response = await request.get(`${API_URL}/effects/presets`);
    await expect(response).toBeOK();
    const presets = await response.json();
    const created = presets.find((preset: { name: string }) => preset.name === name);
    if (created)
      await expect(await request.delete(`${API_URL}/effects/presets/${created.id}`)).toBeOK();
  }
});
