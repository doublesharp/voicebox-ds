export interface StudioDirection {
  instruct: string;
  seed: number | null;
  max_chunk_chars: number;
  crossfade_ms: number;
  speed?: number;
}
export interface StudioPassage {
  id: string;
  text: string;
  language: string;
  chapter?: string | null;
  profile_id: string | null;
  voice_snapshot: Record<string, unknown> | null;
  direction: StudioDirection;
  input_revision: number;
  selection_token: number;
  selected_take_id: string | null;
  locked: boolean;
}

import type { EffectConfig } from '@/lib/api/types';

export interface StudioTrack {
  id: string;
  name: string;
  kind: 'voice' | 'music' | 'sfx';
  mute: boolean;
  solo: boolean;
  gain: number;
  effect_gain_db?: number;
  effects_chain?: EffectConfig[];
}
export interface StudioClip {
  id: string;
  passage_id: string | null;
  take_id: string | null;
  asset_id: string;
  track_id: string;
  start_sample: number;
  trim_start_sample: number;
  trim_end_sample: number;
  gain: number;
  fade_in_samples: number;
  fade_out_samples: number;
}
export interface StudioDocument {
  schema_version: 1;
  sample_rate: 48000;
  channels: 2;
  language: string;
  passages: StudioPassage[];
  tracks: StudioTrack[];
  clips: StudioClip[];
  pronunciation_rules?: import('./pronunciation').PronunciationRule[];
  video_reference?: {
    name: string;
    frame_rate: number;
    time_origin_sample: number;
    duration_seconds: number | null;
  } | null;
  scene_targets?: Record<string, { start_sample: number; end_sample: number }>;
  captions?: {
    source_fingerprint: string;
    reviewed: boolean;
    cues: Array<{
      id: string;
      clip_id: string | null;
      start_sample: number;
      end_sample: number;
      text: string;
    }>;
  };
  take_annotations?: Record<string, { name: string; note: string }>;
  mix: {
    target_lufs: number;
    max_true_peak_dbtp: number;
    normalize: boolean;
    master_gain?: number;
    limiter?: boolean;
    duck_music?: boolean;
    duck_db?: number;
    duck_attack_ms?: number;
    duck_release_ms?: number;
  };
}
export interface AuditionLevel {
  method: 'sample_rms_v1';
  status: 'measured' | 'silence';
  rms: number;
  peak: number;
  frames: number;
  measured_frames: number;
  sample_rate: number;
  channels: number;
}
export interface StudioAsset {
  id: string;
  hash: string;
  sample_rate: number;
  channels: number;
  frames: number;
  duration: number;
  size_bytes: number;
}
export interface StudioTake {
  id: string;
  passage_id: string;
  asset_id: string;
  text: string;
  engine: string;
  model_size: string | null;
  created_at: string;
  request: Record<string, unknown>;
}
export interface StudioJob {
  id: string;
  kind: string;
  status: string;
  phase?: string;
  attempts?: Array<{
    attempt: number;
    phase: string;
    started_at: string;
    updated_at: string;
    error?: string | null;
    phases?: Array<{ phase: string; created_at: string }>;
  }>;
  passage_id?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}
export interface StudioRevision {
  id: string;
  name: string;
  created_at: string;
  document?: StudioDocument;
  project_revision: number;
}
export interface LocalApproval {
  id: string;
  revision_id: string;
  note?: string | null;
  created_at: string;
}
export interface StudioDeliverable {
  processing?: 'dry' | 'processed' | 'master';
  id: string;
  revision_id: string;
  kind: string;
  format: string;
  filename?: string;
  measurements?: Record<string, unknown> | null;
  created_at?: string;
}
export interface StudioProjectSummary {
  id: string;
  name: string;
  client_label: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface StudioProject extends StudioProjectSummary {
  change_token?: string;
  document: StudioDocument;
  takes: StudioTake[];
  assets: StudioAsset[];
  jobs: StudioJob[];
  revisions: StudioRevision[];
  approvals: LocalApproval[];
  deliverables: StudioDeliverable[];
}
export interface StudioEngine {
  id: string;
  name: string;
  model_size?: string;
  languages: string[];
  supports_instruct: boolean;
  supports_seed: boolean;
  expressive_tags: string[];
  recognized_tags?: string[];
  ready: boolean;
  commercial_use: 'allowed' | 'restricted' | 'unknown';
}
export type StudioCommandType =
  | 'set_pronunciation_rules'
  | 'set_video_reference'
  | 'set_scene_target'
  | 'estimate_captions'
  | 'set_captions'
  | 'compose_take'
  | 'update_project'
  | 'add_passages'
  | 'update_passage'
  | 'assign_voice'
  | 'delete_passage'
  | 'reorder_passages'
  | 'select_take'
  | 'annotate_take'
  | 'set_lock'
  | 'insert_passages'
  | 'insert_asset'
  | 'update_clip'
  | 'split_clip'
  | 'duplicate_clip'
  | 'delete_clip'
  | 'update_track'
  | 'update_mix'
  | 'undo'
  | 'redo'
  | 'restore_revision';
export interface StudioCommand {
  operation_id: string;
  expected_revision: number;
  type: StudioCommandType;
  payload: Record<string, unknown>;
}
export type PassageEdit = Partial<
  Pick<StudioPassage, 'text' | 'language' | 'direction' | 'chapter'>
>;
export interface StudioTransport {
  readonly baseUrl: string;
  project(id: string, signal?: AbortSignal): Promise<StudioProject>;
  refreshProject?(id: string, token?: string, signal?: AbortSignal): Promise<StudioProject | null>;
  command(id: string, command: StudioCommand): Promise<StudioProject>;
  checkpoint(
    id: string,
    input: { operation_id: string; expected_revision: number; name: string },
  ): Promise<StudioProject>;
  approve(
    id: string,
    input: { operation_id: string; revision_id: string; note?: string },
  ): Promise<StudioProject>;
}
