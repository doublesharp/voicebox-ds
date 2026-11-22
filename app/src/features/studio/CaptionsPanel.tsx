import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { usePlatform } from '@/platform/PlatformContext';
import {
  type CaptionCue,
  type CaptionDocument,
  type CaptionStatus,
  CaptionsClient,
  type ChaptersResponse,
  type ReferenceVideo,
} from './captions-client';
import { useStudio, useStudioPlayhead } from './context';
import { errorMessage, operationId } from './session';
import { Field, StudioButton } from './ui';
import './captions.css';

const emptyVideo: ReferenceVideo = {
  name: '',
  frame_rate: 24,
  time_origin_sample: 0,
  duration_seconds: null,
};
const seconds = (samples: number, rate: number) => Number((samples / rate).toFixed(6));

export function CaptionsPanel() {
  const studio = useStudio();
  const playhead = useStudioPlayhead();
  const playback = useSyncExternalStore(studio.playback.subscribe, studio.playback.getSnapshot);
  const platform = usePlatform();
  const { project, session, client } = studio;
  const transport = useMemo(() => new CaptionsClient(client.baseUrl), [client.baseUrl]);
  const document = project.document as typeof project.document & {
    captions?: CaptionDocument;
    video_reference?: ReferenceVideo | null;
    scene_targets?: Record<string, { start_sample: number; end_sample: number }>;
  };
  const savedCaptionKey = JSON.stringify(document.captions ?? null);
  const savedVideoKey = JSON.stringify(document.video_reference ?? null);
  const [cues, setCues] = useState<CaptionCue[]>(document.captions?.cues ?? []);
  const [reviewedSource, setReviewedSource] = useState<string | null>(null);
  const [status, setStatus] = useState<CaptionStatus | null>(null);
  const reviewed = reviewedSource !== null && reviewedSource === status?.source_fingerprint;
  const setReviewed = (value: boolean) =>
    setReviewedSource(value ? (status?.source_fingerprint ?? null) : null);
  const [error, setError] = useState('');
  const [publication, setPublication] = useState('');
  const [chaptersData, setChaptersData] = useState<ChaptersResponse | null>(null);
  const [chaptersNote, setChaptersNote] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoName, setVideoName] = useState('');
  const [videoError, setVideoError] = useState('');
  const [videoMetadata, setVideoMetadata] = useState<ReferenceVideo>(
    document.video_reference ?? emptyVideo,
  );
  const [sceneStart, setSceneStart] = useState('0');
  const [sceneEnd, setSceneEnd] = useState('5');
  const video = useRef<HTMLVideoElement>(null);
  const videoSource = useRef('');
  const latestVideo = useRef(videoMetadata);
  latestVideo.current = videoMetadata;
  const rate = document.sample_rate;
  const disabled = !studio.canMutate || studio.actionBusy;
  const savedCues = document.captions?.cues ?? [];
  const dirty = JSON.stringify(cues) !== JSON.stringify(savedCues);
  const passage = document.passages.find((item) => item.id === studio.selectedPassageId);
  const target = passage ? document.scene_targets?.[passage.id] : undefined;
  const selectedTiming = status?.scene_timing.find((item) => item.passage_id === passage?.id);
  const videoPosition = playhead + videoMetadata.time_origin_sample / rate;
  const followPlayback =
    playback.mode === 'timeline' &&
    videoPosition >= 0 &&
    (videoMetadata.duration_seconds === null || videoPosition < videoMetadata.duration_seconds);

  useEffect(() => {
    setCues(JSON.parse(savedCaptionKey)?.cues ?? []);
    setReviewedSource(null);
  }, [savedCaptionKey]);
  useEffect(() => {
    const saved: ReferenceVideo = JSON.parse(savedVideoKey) ?? emptyVideo;
    setVideoMetadata((current) =>
      videoSource.current
        ? { ...saved, name: current.name, duration_seconds: current.duration_seconds }
        : saved,
    );
  }, [savedVideoKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A saved revision changes the authoritative audio/arrangement fingerprint.
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setError('');
    void transport.status(project.id, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setStatus(value);
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [transport, project.id, project.revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing passages discards the previous scene's unsaved interval fields.
  useEffect(() => {
    setSceneStart(String(seconds(target?.start_sample ?? 0, rate)));
    setSceneEnd(String(seconds(target?.end_sample ?? rate * 5, rate)));
  }, [passage?.id, target?.start_sample, target?.end_sample, rate]);
  useEffect(() => {
    return () => {
      if (videoSource.current) URL.revokeObjectURL(videoSource.current);
    };
  }, []);
  useEffect(() => {
    if (!video.current || !videoUrl) return;
    const desired = Math.max(0, playhead + videoMetadata.time_origin_sample / rate);
    if (
      desired >= 0 &&
      Number.isFinite(desired) &&
      Math.abs(video.current.currentTime - desired) > 0.15
    )
      video.current.currentTime = desired;
  }, [playhead, videoUrl, videoMetadata.time_origin_sample, rate]);
  useEffect(() => {
    const element = video.current;
    if (!element || !videoUrl) return;
    let cancelled = false;
    if (followPlayback) {
      void element.play().catch(() => {
        if (!cancelled)
          setVideoError('Video playback was blocked. Use the video controls to start it.');
      });
    } else element.pause();
    return () => {
      cancelled = true;
      element.pause();
    };
  }, [followPlayback, videoUrl]);

  const editCue = (id: string, edit: Partial<CaptionCue>) => {
    setCues((items) => items.map((cue) => (cue.id === id ? { ...cue, ...edit } : cue)));
    setReviewed(false);
    setPublication('');
  };
  const saveCues = () =>
    studio.runAction(async () => {
      if (!status) throw new Error('Wait for current caption source status.');
      await session.command('set_captions', {
        source_fingerprint: status.source_fingerprint,
        reviewed,
        cues,
      });
    });
  const download = (format: 'srt' | 'vtt') =>
    studio.runAction(async () => {
      setPublication('');
      await session.flush();
      if (session.getSnapshot().status !== 'saved')
        throw new Error('Save and reconcile the project before exporting captions.');
      const current = await transport.status(project.id);
      if (!current.exportable)
        throw new Error('Review and save the current captions before export.');
      const name = `${project.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100) || 'studio'}.${format}`;
      const url = transport.exportUrl(project.id, format, current.source_fingerprint);
      const filters = [{ name: 'Captions', extensions: [format] }];
      const result = platform.filesystem.saveFromUrl
        ? await platform.filesystem.saveFromUrl(name, url, filters)
        : await platform.filesystem.saveFile(name, await client.download(url), filters);
      setPublication(
        result?.status === 'saved'
          ? 'Captions saved.'
          : result?.status === 'cancelled'
            ? 'Save cancelled.'
            : result?.status === 'download_started'
              ? 'Caption download started.'
              : 'Caption save requested.',
      );
    });
  const validCues = cues.every(
    (cue) =>
      Number.isSafeInteger(cue.start_sample) &&
      Number.isSafeInteger(cue.end_sample) &&
      cue.start_sample >= 0 &&
      cue.end_sample > cue.start_sample &&
      cue.text.trim(),
  );

  return (
    <section className="studio-captions" aria-label="Video timing and captions">
      <h3>Video timing &amp; captions</h3>
      <p className="studio-note">
        Speech reviews in Phrase repairs can supply recognized word timings. These describe what
        Whisper recognized, not forced alignment of the script. Review wording and timing before
        export.
      </p>
      <StudioButton
        disabled={disabled}
        onClick={() =>
          studio.runAction(async () => {
            await session.flush();
            if (session.getSnapshot().status !== 'saved')
              throw new Error('Save and reconcile before creating recognized captions.');
            await session.command('recognize_captions', {});
          })
        }
      >
        Use recognized word timings
      </StudioButton>
      <div className="studio-action-row">
        <StudioButton
          disabled={studio.actionBusy || (playback.mode === 'idle' && !document.clips.length)}
          onClick={async () => {
            if (playback.mode !== 'idle') {
              studio.playback.stop();
              return;
            }
            setError('');
            await session.flush();
            const saved = session.getSnapshot();
            if (saved.status !== 'saved') {
              setError('Save and reconcile the project before previewing.');
              return;
            }
            const latest = saved.project ?? project;
            await studio.playback.timeline(
              latest.document,
              latest.assets,
              (id) => client.assetAudio(id),
              playhead,
              `Caption review · draft ${latest.revision}`,
            );
          }}
        >
          {playback.mode === 'idle' ? 'Play narration preview' : 'Stop narration preview'}
        </StudioButton>
      </div>
      <p className="studio-note">
        Attach a local reference video for this session. The project keeps its timing and filename;
        choose the file again after reopening. Video bytes stay outside the project archive.
      </p>
      <Field label="Reference video">
        <Input
          type="file"
          accept="video/*"
          disabled={disabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            if (videoSource.current) URL.revokeObjectURL(videoSource.current);
            const url = URL.createObjectURL(file);
            videoSource.current = url;
            setVideoUrl(url);
            setVideoName(file.name);
            setVideoMetadata({ ...latestVideo.current, name: file.name, duration_seconds: null });
            setVideoError('');
          }}
        />
      </Field>
      {(videoName || document.video_reference?.name) && (
        <p className="studio-note">
          {videoName || document.video_reference?.name}
          {!videoUrl && ' · Choose this file to restore playback.'}
        </p>
      )}
      {videoUrl && (
        <video
          key={videoUrl}
          ref={video}
          src={videoUrl}
          controls
          muted
          playsInline
          preload="metadata"
          aria-label="Reference video preview"
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration;
            if (Number.isFinite(duration) && duration > 0)
              setVideoMetadata((value) => ({ ...value, duration_seconds: duration }));
          }}
          onError={() =>
            setVideoError(
              'This video cannot be played here. Choose a supported local video format.',
            )
          }
        />
      )}
      {videoError && (
        <p role="alert" className="studio-error">
          {videoError}
        </p>
      )}
      <div className="studio-field-grid">
        <Field label="Frame rate (fps)">
          <Input
            type="number"
            min={1}
            max={240}
            step={0.001}
            value={videoMetadata.frame_rate}
            disabled={disabled}
            onChange={(event) =>
              setVideoMetadata({ ...videoMetadata, frame_rate: Number(event.target.value) })
            }
          />
        </Field>
        <Field label="Video time at Studio 0 (s)">
          <Input
            type="number"
            step={0.001}
            value={seconds(videoMetadata.time_origin_sample, rate)}
            disabled={disabled}
            onChange={(event) =>
              setVideoMetadata({
                ...videoMetadata,
                time_origin_sample: Math.round(Number(event.target.value) * rate),
              })
            }
          />
        </Field>
      </div>
      <div className="studio-action-row">
        <StudioButton
          disabled={
            disabled ||
            !videoMetadata.name ||
            !Number.isFinite(videoMetadata.frame_rate) ||
            videoMetadata.frame_rate < 1 ||
            videoMetadata.frame_rate > 240
          }
          onClick={() =>
            void studio.runAction(() =>
              session.command('set_video_reference', { reference: videoMetadata }),
            )
          }
        >
          Save video timing
        </StudioButton>
        <StudioButton
          disabled={!videoUrl}
          onClick={() => {
            if (!video.current) return;
            const next = Math.max(
              0,
              video.current.currentTime - videoMetadata.time_origin_sample / rate,
            );
            studio.setPlayhead(next);
          }}
        >
          Use video position
        </StudioButton>
        {document.video_reference && (
          <StudioButton
            disabled={disabled}
            onClick={() =>
              void studio.runAction(() =>
                session.command('set_video_reference', { reference: null }),
              )
            }
          >
            Clear video reference
          </StudioButton>
        )}
      </div>
      <p className="studio-note">
        Video preview is muted. Studio playback supplies the narration and moves the video playhead.
      </p>

      {passage && (
        <div className="studio-caption-scene">
          <h4>Selected passage scene</h4>
          <div className="studio-field-grid">
            <Field label="Scene start (s)">
              <Input
                type="number"
                min={0}
                step={1 / videoMetadata.frame_rate}
                value={sceneStart}
                disabled={disabled}
                onChange={(event) => setSceneStart(event.target.value)}
              />
            </Field>
            <Field label="Scene end (s)">
              <Input
                type="number"
                min={0}
                step={1 / videoMetadata.frame_rate}
                value={sceneEnd}
                disabled={disabled}
                onChange={(event) => setSceneEnd(event.target.value)}
              />
            </Field>
          </div>
          <div className="studio-action-row">
            <StudioButton
              disabled={
                disabled ||
                !Number.isFinite(Number(sceneStart)) ||
                !Number.isFinite(Number(sceneEnd)) ||
                Number(sceneStart) < 0 ||
                Number(sceneEnd) <= Number(sceneStart)
              }
              onClick={() =>
                void studio.runAction(() =>
                  session.command('set_scene_target', {
                    passage_id: passage.id,
                    start_sample: Math.round(Number(sceneStart) * rate),
                    end_sample: Math.round(Number(sceneEnd) * rate),
                  }),
                )
              }
            >
              Save scene target
            </StudioButton>
            {target && (
              <StudioButton
                disabled={disabled}
                onClick={() =>
                  void studio.runAction(() =>
                    session.command('set_scene_target', { passage_id: passage.id, remove: true }),
                  )
                }
              >
                Remove scene target
              </StudioButton>
            )}
            {target && (
              <StudioButton onClick={() => studio.setPlayhead(target.start_sample / rate)}>
                Seek scene start
              </StudioButton>
            )}
          </div>
          {selectedTiming && (
            <p className="studio-note">
              Target {selectedTiming.target_seconds.toFixed(2)}s · selected take{' '}
              {selectedTiming.selected_seconds?.toFixed(2) ?? 'unavailable'}s · placed audio{' '}
              {selectedTiming.placed_seconds.toFixed(2)}s
              {selectedTiming.delta_seconds != null &&
                ` · ${selectedTiming.delta_seconds >= 0 ? '+' : ''}${selectedTiming.delta_seconds.toFixed(2)}s against target`}
            </p>
          )}
        </div>
      )}

      <h4>Caption cues</h4>
      <p className="studio-note">
        Build estimates from audible clip intervals, then audition the final audio and correct
        wording and timing, especially after trimming. Estimates contain whole passages and have no
        word alignment. Cue times and exports use the Studio audio timeline.
      </p>
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      {document.captions && status && !status.current && (
        <p role="alert" className="studio-error">
          Audio, script, or arrangement changed. Review these cues against the current audio before
          exporting.
        </p>
      )}
      {document.captions && status?.current && !status.reviewed && (
        <p className="studio-note">Estimated captions need review before export.</p>
      )}
      <div className="studio-action-row">
        <StudioButton
          disabled={disabled || dirty}
          onClick={() => void studio.runAction(() => session.command('estimate_captions'))}
        >
          Build caption estimates
        </StudioButton>
        <StudioButton
          disabled={disabled || dirty}
          onClick={() =>
            void studio.runAction(() =>
              session.command('estimate_captions', {
                split_cues: true,
                max_chars_per_line: 42,
                max_lines: 2,
              }),
            )
          }
        >
          Build YouTube cues (42-char)
        </StudioButton>
        <StudioButton
          disabled={disabled || dirty || !document.clips.length}
          onClick={() =>
            void studio.runAction(async () => {
              setError('');
              setPublication('');
              const aligned = await transport.align(project.id, {
                maxCharsPerLine: 42,
                maxLines: 2,
              });
              setCues(aligned.captions.cues);
              setReviewed(false);
              setPublication(aligned.note);
            })
          }
        >
          Align with Whisper
        </StudioButton>
        <StudioButton
          disabled={disabled}
          onClick={() => {
            setCues((items) => [
              ...items,
              {
                id: operationId(),
                clip_id: null,
                start_sample: Math.round(playhead * rate),
                end_sample: Math.round((playhead + 2) * rate),
                text: '',
              },
            ]);
            setReviewed(false);
          }}
        >
          Add cue at playhead
        </StudioButton>
        {dirty && (
          <StudioButton
            disabled={disabled}
            onClick={() => {
              setCues(savedCues);
              setReviewed(false);
            }}
          >
            Discard local cue edits
          </StudioButton>
        )}
      </div>
      <div className="studio-caption-cues">
        {cues.map((cue, index) => (
          <div className="studio-caption-cue" key={cue.id}>
            <strong>Cue {index + 1}</strong>
            <div className="studio-field-grid">
              <Field label={`Cue ${index + 1} start (s)`}>
                <Input
                  type="number"
                  min={0}
                  step={0.001}
                  value={seconds(cue.start_sample, rate)}
                  disabled={disabled}
                  onChange={(event) =>
                    editCue(cue.id, { start_sample: Math.round(Number(event.target.value) * rate) })
                  }
                />
              </Field>
              <Field label={`Cue ${index + 1} end (s)`}>
                <Input
                  type="number"
                  min={0}
                  step={0.001}
                  value={seconds(cue.end_sample, rate)}
                  disabled={disabled}
                  onChange={(event) =>
                    editCue(cue.id, { end_sample: Math.round(Number(event.target.value) * rate) })
                  }
                />
              </Field>
            </div>
            <Field label={`Cue ${index + 1} text`}>
              <Textarea
                value={cue.text}
                rows={2}
                disabled={disabled}
                onChange={(event) => editCue(cue.id, { text: event.target.value })}
              />
            </Field>
            <div className="studio-action-row">
              <StudioButton onClick={() => studio.setPlayhead(cue.start_sample / rate)}>
                Seek cue {index + 1}
              </StudioButton>
              <StudioButton
                disabled={disabled}
                onClick={() => {
                  setCues((items) => items.filter((item) => item.id !== cue.id));
                  setReviewed(false);
                }}
              >
                Remove cue {index + 1}
              </StudioButton>
            </div>
          </div>
        ))}
      </div>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={disabled || !cues.length || !validCues || !status}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        I reviewed cue wording and timing against the current edited audio.
      </label>
      <div className="studio-action-row">
        <StudioButton
          disabled={disabled || !status || !validCues || (!dirty && !reviewed)}
          onClick={() => void saveCues()}
        >
          {reviewed ? 'Save reviewed captions' : 'Save caption draft'}
        </StudioButton>
        <StudioButton
          disabled={disabled || dirty || !status?.exportable}
          onClick={() => void download('srt')}
        >
          Export SRT
        </StudioButton>
        <StudioButton
          disabled={disabled || dirty || !status?.exportable}
          onClick={() => void download('vtt')}
        >
          Export WebVTT
        </StudioButton>
      </div>
      {publication && <output aria-live="polite">{publication}</output>}
      <details
        className="studio-advanced"
        onToggle={(event) => {
          if (!event.currentTarget.open) return;
          setChaptersNote('');
          void transport
            .chapters(project.id)
            .then((result) => setChaptersData(result))
            .catch((reason) => setChaptersNote(errorMessage(reason)));
        }}
      >
        <summary>YouTube chapters &amp; NLE markers</summary>
        <p className="studio-note">
          Generated from placed timeline clips and optional passage chapter headings. Use{' '}
          <code>## Chapter Name</code> when pasting a script or set a chapter title on any passage.
        </p>
        <div className="studio-action-row">
          <StudioButton
            disabled={studio.actionBusy}
            onClick={() =>
              void studio.runAction(async () => {
                const result = await transport.chapters(project.id);
                setChaptersData(result);
                setChaptersNote(
                  result.chapters.length
                    ? `Loaded ${result.chapters.length} chapter markers.`
                    : 'Place narration clips on the timeline to build chapters.',
                );
              })
            }
          >
            Refresh chapters
          </StudioButton>
          <StudioButton
            disabled={!chaptersData?.youtube_text}
            onClick={() => {
              if (!chaptersData?.youtube_text) return;
              void navigator.clipboard?.writeText(chaptersData.youtube_text);
              setChaptersNote('Copied YouTube chapters to clipboard.');
            }}
          >
            Copy YouTube chapters
          </StudioButton>
          {(['youtube', 'fcpxml', 'csv'] as const).map((fmt) => {
            const label =
              fmt === 'youtube'
                ? 'Export Chapters (.txt)'
                : fmt === 'fcpxml'
                  ? 'Export FCPXML'
                  : 'Export Resolve CSV';
            const ext = fmt === 'youtube' ? 'txt' : fmt;
            return (
              <StudioButton
                key={fmt}
                disabled={studio.actionBusy || !document.clips.length}
                onClick={() =>
                  void studio.runAction(async () => {
                    const safe =
                      project.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100) || 'studio';
                    const url = transport.chaptersExportUrl(project.id, fmt);
                    const filters = [{ name: label, extensions: [ext] }];
                    const result = platform.filesystem.saveFromUrl
                      ? await platform.filesystem.saveFromUrl(
                          `${safe}-markers.${ext}`,
                          url,
                          filters,
                        )
                      : await platform.filesystem.saveFile(
                          `${safe}-markers.${ext}`,
                          await client.download(url),
                          filters,
                        );
                    setChaptersNote(
                      result?.status === 'saved'
                        ? `${label} saved.`
                        : result?.status === 'cancelled'
                          ? 'Save cancelled.'
                          : `${label} requested.`,
                    );
                  })
                }
              >
                {label}
              </StudioButton>
            );
          })}
        </div>
        {chaptersData?.youtube_text && <pre>{chaptersData.youtube_text}</pre>}
        {chaptersNote && <p className="studio-note">{chaptersNote}</p>}
      </details>
    </section>
  );
}
