import { StudioApiError } from './client';

export interface CaptionCue {
  id: string;
  clip_id: string | null;
  start_sample: number;
  end_sample: number;
  text: string;
}
export interface CaptionDocument {
  source_fingerprint: string;
  reviewed: boolean;
  cues: CaptionCue[];
}
export interface ReferenceVideo {
  name: string;
  frame_rate: number;
  time_origin_sample: number;
  duration_seconds: number | null;
}
export interface CaptionStatus {
  source_fingerprint: string;
  current: boolean;
  reviewed: boolean;
  exportable: boolean;
  captions: CaptionDocument | null;
  scene_timing: Array<{
    passage_id: string;
    target_seconds: number;
    selected_seconds: number | null;
    placed_seconds: number;
    delta_seconds: number | null;
  }>;
}
export interface ChapterItem {
  passage_id: string;
  clip_id: string;
  title: string;
  start_sample: number;
  start_seconds: number;
  timestamp: string;
}
export interface ChaptersResponse {
  chapters: ChapterItem[];
  youtube_text: string;
}
export interface AlignCaptionsResponse {
  method: 'whisper' | 'proportional';
  note: string;
  captions: CaptionDocument;
}
export class CaptionsClient {
  constructor(
    private readonly endpoint: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  exportUrl(projectId: string, format: 'srt' | 'vtt', fingerprint: string) {
    const query = new URLSearchParams({ format, source_fingerprint: fingerprint });
    return `${this.endpoint.replace(/\/+$/, '')}/studio/v1/projects/${encodeURIComponent(projectId)}/captions/export?${query}`;
  }
  chaptersExportUrl(projectId: string, format: 'youtube' | 'fcpxml' | 'csv') {
    const query = new URLSearchParams({ format });
    return `${this.endpoint.replace(/\/+$/, '')}/studio/v1/projects/${encodeURIComponent(projectId)}/chapters/export?${query}`;
  }
  async chapters(projectId: string, signal?: AbortSignal): Promise<ChaptersResponse> {
    const fetcher = this.fetcher;
    const response = await fetcher(
      `${this.endpoint.replace(/\/+$/, '')}/studio/v1/projects/${encodeURIComponent(projectId)}/chapters`,
      { signal },
    );
    const value = await response.json();
    if (!response.ok)
      throw new StudioApiError(
        typeof value?.detail === 'string'
          ? value.detail
          : `Chapters unavailable (${response.status})`,
        response.status,
      );
    return value as ChaptersResponse;
  }
  async align(
    projectId: string,
    options: { maxCharsPerLine?: number; maxLines?: number; modelSize?: string } = {},
  ): Promise<AlignCaptionsResponse> {
    const fetcher = this.fetcher;
    const query = new URLSearchParams();
    if (options.maxCharsPerLine) query.set('max_chars_per_line', String(options.maxCharsPerLine));
    if (options.maxLines) query.set('max_lines', String(options.maxLines));
    if (options.modelSize) query.set('model_size', options.modelSize);
    const qs = query.toString();
    const response = await fetcher(
      `${this.endpoint.replace(/\/+$/, '')}/studio/v1/projects/${encodeURIComponent(projectId)}/captions/align${qs ? `?${qs}` : ''}`,
      { method: 'POST' },
    );
    const value = await response.json();
    if (!response.ok)
      throw new StudioApiError(
        typeof value?.detail === 'string'
          ? value.detail
          : `Caption alignment failed (${response.status})`,
        response.status,
      );
    return value as AlignCaptionsResponse;
  }
  async status(projectId: string, signal?: AbortSignal): Promise<CaptionStatus> {
    const fetcher = this.fetcher;
    const response = await fetcher(
      `${this.endpoint.replace(/\/+$/, '')}/studio/v1/projects/${encodeURIComponent(projectId)}/captions`,
      { signal },
    );
    const value = await response.json();
    if (!response.ok)
      throw new StudioApiError(
        typeof value?.detail === 'string'
          ? value.detail
          : `Caption status unavailable (${response.status})`,
        response.status,
      );
    if (
      !value ||
      !/^[0-9a-f]{64}$/.test(value.source_fingerprint) ||
      ['current', 'reviewed', 'exportable'].some((key) => typeof value[key] !== 'boolean') ||
      !Array.isArray(value.scene_timing)
    )
      throw new Error('Invalid caption status response. Refresh before exporting.');
    return value as CaptionStatus;
  }
}
