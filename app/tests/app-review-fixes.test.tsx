import { describe, expect, test } from 'bun:test';
import { htmlToText } from '../src/components/Generation/ParalinguisticInput';
import i18n from '../src/i18n';
import { MODEL_DISPLAY_NAMES } from '../src/lib/hooks/useRestoreActiveTasks';
import { formatDate, formatEngineName } from '../src/lib/utils/format';
import { useStoryStore } from '../src/stores/storyStore';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

if (typeof globalThis.Node === 'undefined') {
  (globalThis as unknown as { Node: { TEXT_NODE: number; ELEMENT_NODE: number } }).Node = {
    TEXT_NODE,
    ELEMENT_NODE,
  };
}

interface FakeNode {
  nodeType: number;
  textContent?: string;
  tagName?: string;
  attrs?: Record<string, string>;
  childNodes?: FakeNode[];
  firstChild?: FakeNode | null;
  hasAttribute?: (name: string) => boolean;
  getAttribute?: (name: string) => string | null;
}

const textNode = (text: string): FakeNode => ({ nodeType: TEXT_NODE, textContent: text });
const elNode = (
  tagName: string,
  children: FakeNode[] = [],
  attrs: Record<string, string> = {},
): FakeNode => ({
  nodeType: ELEMENT_NODE,
  tagName: tagName.toUpperCase(),
  attrs,
  childNodes: children,
  firstChild: children[0] ?? null,
  hasAttribute: (name: string) => name in attrs,
  getAttribute: (name: string) => attrs[name] ?? null,
});

describe('ParalinguisticInput htmlToText newline handling', () => {
  test('preserves newlines across <div>, <p>, <br>, and badge elements', () => {
    const container = elNode('div', [
      textNode('Hello world'),
      elNode('div', [textNode('Second line')]),
      elNode('div', [elNode('br')]),
      elNode('div', [
        textNode('Third '),
        elNode('span', [textNode('😂 laugh')], { 'data-ptag': '[laugh]' }),
        textNode(' line'),
      ]),
    ]);
    expect(htmlToText(container as unknown as HTMLElement)).toBe(
      'Hello world\nSecond line\n\nThird [laugh] line',
    );
  });

  test('strips zero-width spaces around badges without losing line breaks', () => {
    const container = elNode('div', [
      textNode('\u200B'),
      elNode('span', [textNode('sigh')], { 'data-ptag': '[sigh]' }),
      textNode('\u200B'),
      elNode('br'),
      textNode('Next sentence'),
    ]);
    expect(htmlToText(container as unknown as HTMLElement)).toBe('[sigh]\nNext sentence');
  });
});

describe('storyStore trim-aware durations and live active story updates', () => {
  const makeItem = (
    id: string,
    generationId: string,
    startMs: number,
    durationSec: number,
    trimStartMs = 0,
    trimEndMs = 0,
  ) =>
    ({
      id,
      story_id: 'story-1',
      generation_id: generationId,
      profile_id: 'p1',
      profile_name: 'Host',
      text: 'Clip',
      language: 'en',
      duration: durationSec,
      start_time_ms: startMs,
      track: 0,
      trim_start_ms: trimStartMs,
      trim_end_ms: trimEndMs,
      created_at: '2026-01-01T00:00:00Z',
    }) as never;

  test('play computes totalDurationMs using trimmed effective duration', () => {
    useStoryStore.getState().stop();
    useStoryStore.getState().play('story-1', [makeItem('item-1', 'gen-1', 1000, 10, 2000, 3000)]);
    // 1000ms start + (10000 - 2000 - 3000)ms effective = 6000ms
    expect(useStoryStore.getState().totalDurationMs).toBe(6000);
    useStoryStore.getState().stop();
  });

  test('setActiveStory updates totalDurationMs even when staying on the same story', () => {
    useStoryStore.getState().stop();
    const first = [makeItem('item-1', 'gen-1', 0, 4)];
    useStoryStore.getState().setActiveStory('story-1', first, 4000);
    expect(useStoryStore.getState().totalDurationMs).toBe(4000);

    const expanded = [...first, makeItem('item-2', 'gen-1', 4000, 6)];
    useStoryStore.getState().setActiveStory('story-1', expanded, 10000);
    expect(useStoryStore.getState().totalDurationMs).toBe(10000);

    useStoryStore.getState().seek(8500);
    expect(useStoryStore.getState().currentTimeMs).toBe(8500);
    useStoryStore.getState().stop();
  });
});

describe('format.ts & MODEL_DISPLAY_NAMES completeness', () => {
  test('formatEngineName formats omnivoice and multi-size engines', () => {
    expect(formatEngineName('omnivoice')).toBe('OmniVoice');
    expect(formatEngineName('qwen', '1.7B')).toBe('Qwen 1.7B');
    expect(formatEngineName('qwen_custom_voice', '1.7B')).toBe('Qwen CustomVoice 1.7B');
    expect(formatEngineName('tada', '3B')).toBe('TADA 3B');
    expect(formatEngineName('kokoro', '82M')).toBe('Kokoro 82M');
  });

  test('formatDate uses localized date-fns locales for it, ko, and pt-BR', async () => {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await i18n.changeLanguage('ko');
    expect(formatDate(fiveMinsAgo)).toContain('분');
    await i18n.changeLanguage('it');
    expect(formatDate(fiveMinsAgo)).toContain('minuti');
    await i18n.changeLanguage('pt-BR');
    expect(formatDate(fiveMinsAgo)).toContain('minutos');
    await i18n.changeLanguage('en');
  });

  test('MODEL_DISPLAY_NAMES maps all supported engines and sizes', () => {
    for (const key of [
      'qwen-tts-1.7B',
      'qwen-custom-voice-1.7B',
      'qwen-voice-design-1.7B',
      'luxtts',
      'chatterbox-tts',
      'chatterbox-turbo',
      'tada-1b',
      'tada-3b-ml',
      'kokoro',
      'omnivoice',
      'whisper-turbo',
      'qwen3-4b',
    ]) {
      expect(MODEL_DISPLAY_NAMES[key]).toBeTruthy();
    }
  });
});
