export interface PronunciationRule {
  id: string;
  source: string;
  replacement: string;
  profile_id: string | null;
  case_sensitive: boolean;
  whole_word: boolean;
  recording_asset_id?: string;
}

export function pronunciationError(rules: PronunciationRule[]) {
  if (rules.length > 200) return 'Keep the dictionary to 200 rules or fewer.';
  const ids = new Set<string>();
  for (const rule of rules) {
    if (
      !rule.id ||
      ids.has(rule.id) ||
      !rule.source.trim() ||
      (!rule.replacement.trim() && !rule.recording_asset_id) ||
      [...rule.source].length > 200 ||
      [...rule.replacement].length > 500 ||
      /[\r\n\0]/.test(rule.source + rule.replacement)
    )
      return 'Enter a word or phrase and add a spoken alias or recording.';
    ids.add(rule.id);
  }
  return null;
}

/** Matches the backend's single-pass, leftmost-longest literal alias semantics. */
export function previewPronunciation(
  text: string,
  rules: PronunciationRule[],
  profileId: string | null,
  useRecordings = false,
) {
  const applicable = rules
    .filter((rule) =>
      rule.source &&
      (rule.replacement.trim() || (useRecordings && rule.recording_asset_id)) &&
      (!rule.profile_id || rule.profile_id === profileId),
    )
    .slice()
    .sort(
      (a, b) =>
        [...b.source].length - [...a.source].length ||
        Number(a.profile_id === null) - Number(b.profile_id === null),
    );
  const input = [...text];
  const output: string[] = [];
  const recordings = new Set<string>();
  const substitutions: Array<{
    rule_id: string;
    source: string;
    replacement: string;
    start: number;
    end: number;
  }> = [];
  const word = (character: string) => /[\p{L}\p{N}_]/u.test(character);
  let index = 0;
  while (index < input.length) {
    const match = applicable.find((rule) => {
      const end = index + [...rule.source].length;
      if (end > input.length) return false;
      const actual = input.slice(index, end).join('');
      return (
        (rule.case_sensitive
          ? actual === rule.source
          : actual.toLowerCase() === rule.source.toLowerCase()) &&
        (!rule.whole_word ||
          ((index === 0 || !word(input[index - 1])) && (end === input.length || !word(input[end]))))
      );
    });
    if (match) {
      const end = index + [...match.source].length;
      const source = input.slice(index, end).join('');
      output.push(match.replacement.trim() ? match.replacement : source);
      if (useRecordings && match.recording_asset_id) recordings.add(match.id);
      if (match.replacement.trim()) {
        substitutions.push({ rule_id: match.id, source, replacement: match.replacement, start: index, end });
      }
      index = end;
    } else {
      output.push(input[index]);
      index++;
    }
  }
  return { text: output.join(''), substitutions, recordings };
}

export interface PronunciationPackEntry {
  source: string;
  replacement: string;
  case_sensitive: boolean;
  whole_word: boolean;
}

export const EMBEDDED_FIRMWARE_PACK: PronunciationPackEntry[] = [
  { source: 'I2S', replacement: 'eye two ess', case_sensitive: true, whole_word: true },
  { source: 'I2C', replacement: 'eye squared see', case_sensitive: true, whole_word: true },
  { source: 'SPI', replacement: 'S P I', case_sensitive: true, whole_word: true },
  { source: 'DMA', replacement: 'D M A', case_sensitive: true, whole_word: true },
  { source: 'UART', replacement: 'you art', case_sensitive: true, whole_word: true },
  { source: 'GPIO', replacement: 'G P I O', case_sensitive: true, whole_word: true },
  { source: 'ADC', replacement: 'A D C', case_sensitive: true, whole_word: true },
  { source: 'DAC', replacement: 'dack', case_sensitive: true, whole_word: true },
  { source: 'PWM', replacement: 'P W M', case_sensitive: true, whole_word: true },
  { source: 'RTOS', replacement: 'R toss', case_sensitive: true, whole_word: true },
  { source: 'FreeRTOS', replacement: 'free R toss', case_sensitive: false, whole_word: true },
  { source: 'ISR', replacement: 'I S R', case_sensitive: true, whole_word: true },
  { source: 'MCU', replacement: 'M C U', case_sensitive: true, whole_word: true },
  { source: 'STM32', replacement: 'S T M thirty two', case_sensitive: true, whole_word: true },
  { source: 'ESP32', replacement: 'E S P thirty two', case_sensitive: true, whole_word: true },
  { source: 'RP2040', replacement: 'R P twenty forty', case_sensitive: true, whole_word: true },
  { source: 'FAT32', replacement: 'fat thirty two', case_sensitive: false, whole_word: true },
  { source: 'PCM', replacement: 'P C M', case_sensitive: true, whole_word: true },
  { source: 'FLAC', replacement: 'flack', case_sensitive: true, whole_word: true },
  { source: 'MP3', replacement: 'M P three', case_sensitive: false, whole_word: true },
  { source: 'WAV', replacement: 'wave', case_sensitive: true, whole_word: true },
  { source: 'OLED', replacement: 'oh led', case_sensitive: true, whole_word: true },
  { source: 'PCB', replacement: 'P C B', case_sensitive: true, whole_word: true },
  { source: 'EEPROM', replacement: 'E E prom', case_sensitive: true, whole_word: true },
  { source: 'SRAM', replacement: 'S ram', case_sensitive: true, whole_word: true },
  { source: 'FIFO', replacement: 'figh foe', case_sensitive: true, whole_word: true },
  { source: 'CRC32', replacement: 'C R C thirty two', case_sensitive: true, whole_word: true },
  { source: 'USB-C', replacement: 'U S B C', case_sensitive: false, whole_word: true },
  { source: 'JTAG', replacement: 'J tag', case_sensitive: true, whole_word: true },
  { source: 'SWD', replacement: 'S W D', case_sensitive: true, whole_word: true },
  { source: 'kHz', replacement: 'kilohertz', case_sensitive: true, whole_word: false },
  { source: 'MHz', replacement: 'megahertz', case_sensitive: true, whole_word: false },
  { source: 'GHz', replacement: 'gigahertz', case_sensitive: true, whole_word: false },
  { source: 'kbps', replacement: 'kilobits per second', case_sensitive: false, whole_word: false },
  { source: 'mW', replacement: 'milliwatts', case_sensitive: true, whole_word: false },
  { source: 'mA', replacement: 'milliamps', case_sensitive: true, whole_word: false },
  { source: 'LUFS', replacement: 'luffs', case_sensitive: true, whole_word: true },
  { source: 'dBTP', replacement: 'D B true peak', case_sensitive: true, whole_word: true },
  { source: 'API', replacement: 'A P I', case_sensitive: true, whole_word: true },
  { source: 'CLI', replacement: 'C L I', case_sensitive: true, whole_word: true },
  { source: 'SDK', replacement: 'S D K', case_sensitive: true, whole_word: true },
];

export interface JargonSuggestion {
  source: string;
  category: 'hex' | 'unit' | 'acronym' | 'identifier';
  count: number;
  suggested_replacement: string;
  case_sensitive: boolean;
  whole_word: boolean;
}

const COMMON_SHORT_CAPS = new Set([
  'A',
  'I',
  'OK',
  'TV',
  'US',
  'UK',
  'AM',
  'PM',
  'NO',
  'SO',
  'OR',
  'TO',
  'IN',
  'ON',
  'IT',
  'IS',
]);

const PACK_LOOKUP = new Map(
  EMBEDDED_FIRMWARE_PACK.map((entry) => [entry.source.toLowerCase(), entry.replacement]),
);

function suggestSpoken(token: string, category: JargonSuggestion['category']) {
  const known = PACK_LOOKUP.get(token.toLowerCase());
  if (known) return known;
  if (category === 'hex') return `zero ex ${token.slice(2).toUpperCase().split('').join(' ')}`;
  if (category === 'identifier') return token.replace(/_/g, ' ');
  if (category === 'acronym')
    return token.replace(/-/g, ' ').split('').join(' ').replace(/\s+/g, ' ');
  return token;
}

export function scanScriptJargon(
  passages: Array<{ text: string }>,
  existingRules: PronunciationRule[],
): JargonSuggestion[] {
  const existing = new Set(
    existingRules.map((rule) => (rule.case_sensitive ? rule.source : rule.source.toLowerCase())),
  );
  const patterns: Array<[JargonSuggestion['category'], RegExp]> = [
    ['hex', /\b0x[0-9A-Fa-f]{2,}\b/g],
    ['unit', /\b\d+(?:\.\d+)?\s?(?:kHz|MHz|GHz|kbps|ms|us|μs|mW|mA|kB|MB|GB)\b/g],
    ['acronym', /\b[A-Z][A-Z0-9]{1,7}(?:-[A-Z0-9]+)?\b/g],
    ['identifier', /\b[a-z]+_[a-z0-9_]+\b/g],
  ];
  const counts = new Map<string, JargonSuggestion>();
  for (const passage of passages) {
    const cleaned = (passage.text || '').replace(/\[[^\]]*\]/g, ' ');
    for (const [category, regex] of patterns) {
      regex.lastIndex = 0;
      for (const match of cleaned.matchAll(regex)) {
        const token = match[0];
        if (category === 'acronym' && COMMON_SHORT_CAPS.has(token)) continue;
        if (existing.has(token) || existing.has(token.toLowerCase())) continue;
        const current = counts.get(token);
        if (current) {
          current.count += 1;
        } else {
          counts.set(token, {
            source: token,
            category,
            count: 1,
            suggested_replacement: suggestSpoken(token, category),
            case_sensitive: category === 'acronym' || category === 'unit',
            whole_word: category !== 'unit',
          });
        }
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export function parsePronunciationImport(raw: string, makeId: () => string): PronunciationRule[] {
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rules?: unknown }).rules)
      ? (parsed as { rules: unknown[] }).rules
      : null;
  if (!items) throw new Error('Expected a JSON array of pronunciation rules.');
  return items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid pronunciation rule entry.');
    const rec = item as Record<string, unknown>;
    if (typeof rec.source !== 'string' || typeof rec.replacement !== 'string')
      throw new Error('Each imported rule must include string source and replacement fields.');
    return {
      id: typeof rec.id === 'string' && rec.id.trim() ? rec.id : makeId(),
      source: rec.source,
      replacement: rec.replacement,
      profile_id: typeof rec.profile_id === 'string' && rec.profile_id ? rec.profile_id : null,
      case_sensitive: typeof rec.case_sensitive === 'boolean' ? rec.case_sensitive : false,
      whole_word: typeof rec.whole_word === 'boolean' ? rec.whole_word : true,
    };
  });
}
