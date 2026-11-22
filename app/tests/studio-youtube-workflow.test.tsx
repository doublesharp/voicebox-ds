import { expect, test } from 'bun:test';
import { CaptionsClient } from '../src/features/studio/captions-client';
import { splitScriptWithChapters } from '../src/features/studio/domain';
import {
  EMBEDDED_FIRMWARE_PACK,
  parsePronunciationImport,
  scanScriptJargon,
} from '../src/features/studio/pronunciation';

test('splitScriptWithChapters extracts markdown chapter headings onto passages', () => {
  const input = [
    '## Intro',
    '',
    'Today we build custom MP3 player firmware.',
    '',
    '## I2S & DMA Pipeline',
    'Audio streams directly from FAT32 to the DAC.',
    '',
    'Final wrap up without a new chapter heading.',
  ].join('\n');

  expect(splitScriptWithChapters(input)).toEqual([
    { text: 'Today we build custom MP3 player firmware.', chapter: 'Intro' },
    { text: 'Audio streams directly from FAT32 to the DAC.', chapter: 'I2S & DMA Pipeline' },
    { text: 'Final wrap up without a new chapter heading.', chapter: null },
  ]);
});

test('scanScriptJargon flags uncovered firmware terms and ignores already covered rules', () => {
  const suggestions = scanScriptJargon(
    [
      {
        text: 'Our STM32 reads FAT32 via SPI and streams 48kHz PCM over I2S with 0x2A and ring_buffer_push [pause 400ms].',
      },
    ],
    [
      {
        id: '1',
        source: 'SPI',
        replacement: 'S P I',
        profile_id: null,
        case_sensitive: true,
        whole_word: true,
      },
    ],
  );
  const bySource = new Map(suggestions.map((item) => [item.source, item]));
  expect(bySource.has('SPI')).toBe(false);
  expect(bySource.get('STM32')?.suggested_replacement).toBe('S T M thirty two');
  expect(bySource.get('I2S')?.suggested_replacement).toBe('eye two ess');
  expect(bySource.get('0x2A')?.suggested_replacement).toBe('zero ex 2 A');
  expect(bySource.get('ring_buffer_push')?.suggested_replacement).toBe('ring buffer push');
  expect(EMBEDDED_FIRMWARE_PACK.length).toBeGreaterThan(25);
});

test('parsePronunciationImport validates JSON rule packs', () => {
  let seq = 0;
  const imported = parsePronunciationImport(
    JSON.stringify({
      rules: [{ source: 'PCM5102', replacement: 'P C M fifty one oh two', case_sensitive: true }],
    }),
    () => `id-${++seq}`,
  );
  expect(imported).toEqual([
    {
      id: 'id-1',
      source: 'PCM5102',
      replacement: 'P C M fifty one oh two',
      profile_id: null,
      case_sensitive: true,
      whole_word: true,
    },
  ]);
  expect(() => parsePronunciationImport('{"bad":true}', () => 'x')).toThrow();
});

test('CaptionsClient builds chapter export URLs and calls align/chapters endpoints', async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const client = new CaptionsClient('http://127.0.0.1:17493/', (async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    if (String(url).includes('/chapters')) {
      return Response.json({
        chapters: [
          {
            passage_id: 'p1',
            clip_id: 'c1',
            title: 'Intro',
            start_sample: 0,
            start_seconds: 0,
            timestamp: '00:00',
          },
        ],
        youtube_text: '00:00 Intro\n',
      });
    }
    return Response.json({
      method: 'proportional',
      note: 'Built proportional YouTube cues.',
      captions: { source_fingerprint: 'a'.repeat(64), reviewed: false, cues: [] },
    });
  }) as typeof fetch);

  expect(client.chaptersExportUrl('proj', 'fcpxml')).toBe(
    'http://127.0.0.1:17493/studio/v1/projects/proj/chapters/export?format=fcpxml',
  );
  const chapters = await client.chapters('proj');
  expect(chapters.youtube_text).toBe('00:00 Intro\n');
  const aligned = await client.align('proj', { maxCharsPerLine: 42, maxLines: 2 });
  expect(aligned.method).toBe('proportional');
  expect(seen[1]).toEqual({
    url: 'http://127.0.0.1:17493/studio/v1/projects/proj/captions/align?max_chars_per_line=42&max_lines=2',
    method: 'POST',
  });
});
