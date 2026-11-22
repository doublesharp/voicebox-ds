import type { StudioProfile } from './client';
import type {
  StudioAsset,
  StudioClip,
  StudioDocument,
  StudioEngine,
  StudioPassage,
  StudioProject,
} from './types';
export function splitScript(text: string) {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Splits pasted script text into passages while extracting optional Markdown
 * chapter headings (`## Chapter Title`) onto the next spoken passage.
 */
export function splitScriptWithChapters(
  text: string,
): Array<{ text: string; chapter: string | null }> {
  const blocks = splitScript(text);
  const result: Array<{ text: string; chapter: string | null }> = [];
  let pendingChapter: string | null = null;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const first = lines[0]?.trim() ?? '';
    const headingMatch = /^#{1,3}\s+(.+?)\s*#*$/.exec(first);
    if (headingMatch) {
      const heading = headingMatch[1].trim().slice(0, 120);
      const rest = lines.slice(1).join('\n').trim();
      if (rest) {
        result.push({ text: rest, chapter: heading || null });
        pendingChapter = null;
      } else {
        pendingChapter = heading || null;
      }
      continue;
    }
    result.push({ text: block, chapter: pendingChapter });
    pendingChapter = null;
  }
  return result;
}
export function toSamples(seconds: number, sampleRate = 48000) {
  return Math.round(seconds * sampleRate);
}
export function sourceFrames(asset: StudioAsset, sampleRate = 48000) {
  return Math.round((asset.frames * sampleRate) / asset.sample_rate);
}
export function clipFrames(clip: StudioClip, asset: StudioAsset, sampleRate = 48000) {
  return sourceFrames(asset, sampleRate) - clip.trim_start_sample - clip.trim_end_sample;
}
export function timelineEnd(document: StudioDocument, assets: StudioAsset[]) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return document.clips.reduce((end, clip) => {
    const asset = byId.get(clip.asset_id);
    return asset
      ? Math.max(end, clip.start_sample + clipFrames(clip, asset, document.sample_rate))
      : end;
  }, 0);
}
export function engineForPassage(
  passage: StudioPassage | undefined,
  profiles: StudioProfile[],
  engines: StudioEngine[],
) {
  if (!passage) return undefined;
  const snapshot = passage.voice_snapshot;
  const profile = profiles.find((p) => p.id === passage.profile_id);
  const id =
    snapshot?.engine ||
    snapshot?.preset_engine ||
    snapshot?.default_engine ||
    profile?.preset_engine ||
    profile?.default_engine;
  const candidates = engines.filter((engine) => engine.id === id);
  const size = snapshot?.model_size;
  if (size && size !== 'default') return candidates.find((engine) => engine.model_size === size);
  return candidates.length === 1
    ? candidates[0]
    : candidates.find((engine) => engine.model_size === 'default');
}
export function staleRecordings(document: StudioDocument, project: StudioProject) {
  return document.clips.flatMap((clip) => {
    const passage = document.passages.find((p) => p.id === clip.passage_id);
    const take = project.takes.find((t) => t.id === clip.take_id);
    const frozen = take?.request?.passage as { input_revision?: number } | undefined;
    return passage &&
      take &&
      (passage.text !== take.text ||
        (frozen?.input_revision !== undefined && frozen.input_revision !== passage.input_revision))
      ? [{ clip, passage, take }]
      : [];
  });
}
export function preflight(document: StudioDocument, project: StudioProject, allowStale = false) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!document.clips.length)
    errors.push(
      'The checkpoint has no timeline clips. Insert selected takes before creating a delivery checkpoint.',
    );
  const solo = document.tracks.some((track) => track.solo && !track.mute);
  for (const track of document.tracks)
    if (!Number.isFinite(track.gain) || track.gain < 0)
      errors.push(`Track ${track.id.slice(0, 8)} has invalid gain.`);
  for (const passage of document.passages) {
    const take = project.takes.find((take) => take.id === passage.selected_take_id);
    if (
      !take ||
      take.passage_id !== passage.id ||
      !project.assets.some((a) => a.id === take.asset_id)
    ) {
      errors.push(`Passage ${passage.id.slice(0, 8)} needs selected source audio.`);
      continue;
    }
    const audible = document.clips.some((clip) => {
      const track = document.tracks.find((track) => track.id === clip.track_id);
      const asset = project.assets.find((asset) => asset.id === clip.asset_id);
      const recording = project.takes.find((recording) => recording.id === clip.take_id);
      return (
        clip.passage_id === passage.id &&
        recording?.passage_id === passage.id &&
        clip.asset_id === recording.asset_id &&
        track &&
        !track.mute &&
        (!solo || track.solo) &&
        track.gain > 0 &&
        clip.gain > 0 &&
        asset &&
        clipFrames(clip, asset, document.sample_rate) > 0
      );
    });
    if (!audible) errors.push(`Passage ${passage.id.slice(0, 8)} has no audible narration clip.`);
  }
  for (const clip of document.clips) {
    const asset = project.assets.find((a) => a.id === clip.asset_id);
    if (!asset) {
      errors.push(`Clip ${clip.id.slice(0, 8)} is missing source audio.`);
      continue;
    }
    if (
      !Number.isFinite(clipFrames(clip, asset, document.sample_rate)) ||
      clipFrames(clip, asset, document.sample_rate) <= 0 ||
      !Number.isInteger(clip.trim_start_sample) ||
      clip.trim_start_sample < 0 ||
      !Number.isInteger(clip.trim_end_sample) ||
      clip.trim_end_sample < 0
    )
      errors.push(`Clip ${clip.id.slice(0, 8)} has invalid trims.`);
    if (!document.tracks.some((track) => track.id === clip.track_id))
      errors.push(`Clip ${clip.id.slice(0, 8)} is missing its track.`);
    if (
      !Number.isInteger(clip.start_sample) ||
      clip.start_sample < 0 ||
      !Number.isFinite(clip.gain) ||
      clip.gain < 0 ||
      !Number.isInteger(clip.fade_in_samples) ||
      clip.fade_in_samples < 0 ||
      !Number.isInteger(clip.fade_out_samples) ||
      clip.fade_out_samples < 0
    )
      errors.push(`Clip ${clip.id.slice(0, 8)} has invalid placement or gain.`);
    const passage = document.passages.find((p) => p.id === clip.passage_id);
    const take = project.takes.find((t) => t.id === clip.take_id);
    if (
      (clip.passage_id && (!passage || !take || take.passage_id !== passage.id)) ||
      (clip.take_id && (!take || take.asset_id !== clip.asset_id))
    )
      errors.push('A timeline clip is missing its passage or take relationship.');
    if (passage && passage.selected_take_id !== clip.take_id)
      warnings.push(
        'Timeline audio differs from a passage’s selected take. The pinned timeline audio will render.',
      );
  }
  if (staleRecordings(document, project).length) {
    const message =
      'Script changed or direction changed: a timeline take does not match the checkpoint inputs.';
    if (allowStale)
      warnings.push(`${message} Earlier recordings explicitly acknowledged for this checkpoint.`);
    else errors.push(message);
  }
  if (!document.mix.normalize)
    warnings.push(
      'Loudness normalization is off. Final measurements are available only when the renderer qualifies them.',
    );
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
export function isJobActive(status: string) {
  return ['queued', 'processing', 'running', 'cancelling', 'cancel_requested'].includes(status);
}
export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
