import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = join(import.meta.dir, '../src/i18n/locales');

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

describe('i18n locale parity & effect registry coverage', () => {
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en/translation.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const enKeys = new Set(flattenKeys(en));

  test('en/translation.json includes common.retry, all 13 Pedalboard effects, and YouTube Narration', () => {
    expect(enKeys.has('common.retry')).toBe(true);

    const requiredEffects = [
      'pitch_shift',
      'reverb',
      'delay',
      'chorus',
      'compressor',
      'gain',
      'highpass',
      'lowpass',
      'low_shelf',
      'peak_filter',
      'high_shelf',
      'noise_gate',
      'limiter',
    ];
    for (const effect of requiredEffects) {
      expect(enKeys.has(`effects.types.${effect}.label`)).toBe(true);
    }

    expect(enKeys.has('effects.builtinPresets.YouTube Narration.name')).toBe(true);
    expect(enKeys.has('effects.builtinPresets.YouTube Narration.description')).toBe(true);
  });

  test('all shipped locales contain every key defined in en/translation.json', () => {
    const locales = readdirSync(LOCALES_DIR).filter((d) => !d.startsWith('.'));
    expect(locales.length).toBeGreaterThanOrEqual(9);

    for (const locale of locales) {
      const data = JSON.parse(
        readFileSync(join(LOCALES_DIR, locale, 'translation.json'), 'utf8'),
      ) as Record<string, unknown>;
      const keys = new Set(flattenKeys(data));
      const missing = [...enKeys].filter((k) => !keys.has(k));
      expect({ locale, missing }).toEqual({ locale, missing: [] });
    }
  });
});
