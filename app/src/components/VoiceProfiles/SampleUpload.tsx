import { zodResolver } from '@hookform/resolvers/zod';
import { Mic, Monitor, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { useAudioPlayer } from '@/lib/hooks/useAudioPlayer';
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import { useAddSample, useProfile } from '@/lib/hooks/useProfiles';
import { useSystemAudioCapture } from '@/lib/hooks/useSystemAudioCapture';
import { useTranscription } from '@/lib/hooks/useTranscription';
import { usePlatform } from '@/platform/PlatformContext';
import { useMicrophoneStore } from '@/stores/microphoneStore';
import { useServerStore } from '@/stores/serverStore';
import { currentServerScope, isCurrentServer, type ServerScope } from '@/lib/serverScope';
import { AudioSampleRecording } from './AudioSampleRecording';
import { AudioSampleSystem } from './AudioSampleSystem';
import { AudioSampleUpload } from './AudioSampleUpload';
import { SampleQuality } from './SampleQuality';

const sampleSchema = z.object({
  file: z.instanceof(File, { message: 'Please select an audio file' }),
  referenceText: z
    .string()
    .min(1, 'Reference text is required')
    .max(1000, 'Reference text must be less than 1000 characters'),
});

type SampleFormValues = z.infer<typeof sampleSchema>;

interface SampleUploadProps {
  profileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SampleUpload({ profileId, open, onOpenChange }: SampleUploadProps) {
  const platform = usePlatform();
  const addSample = useAddSample();
  const transcribe = useTranscription();
  const { data: profile } = useProfile(profileId);
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  const transcriptionRevision = useRef(0);
  const uploadRevision = useRef(0);
  const pendingUpload = useRef<symbol | null>(null);
  const currentContext = useRef({ open, profileId, language: profile?.language });
  currentContext.current = { open, profileId, language: profile?.language };
  const { toast } = useToast();
  const [mode, setMode] = useState<'upload' | 'record' | 'system'>('upload');
  const { isPlaying, playPause, cleanup: cleanupAudio } = useAudioPlayer();
  const cleanReferenceAudio = useMicrophoneStore((state) => state.cleanReferenceAudio);

  const form = useForm<SampleFormValues>({
    resolver: zodResolver(sampleSchema),
    defaultValues: {
      referenceText: '',
    },
  });
  const { reset } = form;

  const selectedFile = form.watch('file');

  const {
    isRecording,
    isStarting,
    audioStream: recordingStream,
    usingDefaultMicrophone,
    duration,
    error: recordingError,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecording({
    processing: cleanReferenceAudio ? 'clean' : 'processed',
    maxDurationSeconds: 29,
    onRecordingComplete: (blob, recordedDuration) => {
      // Convert blob to File object
      const file = new File([blob], `recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      form.setValue('file', file, { shouldValidate: true });
      toast({ title: 'Recording complete' });
    },
  });

  const {
    isRecording: isSystemRecording,
    duration: systemDuration,
    error: systemRecordingError,
    isSupported: isSystemAudioSupported,
    startRecording: startSystemRecording,
    stopRecording: stopSystemRecording,
    cancelRecording: cancelSystemRecording,
  } = useSystemAudioCapture({
    maxDurationSeconds: 29,
    onRecordingComplete: (blob, recordedDuration) => {
      // Convert blob to File object
      const file = new File([blob], `system-audio-${Date.now()}.wav`, {
        type: blob.type || 'audio/wav',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      form.setValue('file', file, { shouldValidate: true });
      toast({ title: 'System audio captured' });
    },
  });

  useEffect(() => {
    if (!open) {
      reset();
      setMode('upload');
    }
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;

    return () => {
      transcriptionRevision.current += 1;
      uploadRevision.current += 1;
      pendingUpload.current = null;
      // A stopped recorder can still be converting or retrieving its audio.
      cancelRecording();
      void cancelSystemRecording();
      cleanupAudio();
    };
  }, [open, profileId, serverUrl, serverRevision, cancelRecording, cancelSystemRecording, cleanupAudio]);

  // Show recording errors
  useEffect(() => {
    if (recordingError) {
      toast({
        title: 'Recording error',
        description: recordingError,
        variant: 'destructive',
      });
    }
  }, [recordingError, toast]);

  // Show system audio recording errors
  useEffect(() => {
    if (systemRecordingError) {
      toast({
        title: 'System audio capture error',
        description: systemRecordingError,
        variant: 'destructive',
      });
    }
  }, [systemRecordingError, toast]);

  async function handleTranscribe() {
    const file = form.getValues('file');
    if (!file) {
      toast({
        title: 'No file selected',
        description: 'Choose or record an audio file, then transcribe.',
        variant: 'destructive',
      });
      return;
    }

    const language = profile?.language as 'en' | 'zh' | undefined;
    const serverScope = currentServerScope();
    const referenceText = form.getValues('referenceText');
    const revision = ++transcriptionRevision.current;
    const isCurrent = () =>
      transcriptionRevision.current === revision &&
      isCurrentServer(serverScope) &&
      currentContext.current.open &&
      currentContext.current.profileId === profileId &&
      currentContext.current.language === language &&
      form.getValues('file') === file &&
      form.getValues('referenceText') === referenceText;
    try {
      const result = await transcribe.mutateAsync({ file, language, _serverScope: serverScope });
      if (!isCurrent()) return;
      form.setValue('referenceText', result.text, { shouldValidate: true });
    } catch (error) {
      if (!isCurrent()) return;
      toast({
        title: 'Transcription failed',
        description:
          error instanceof Error ? error.message : 'Enter the transcript manually or try again.',
        variant: 'destructive',
      });
    }
  }

  async function onSubmit(data: SampleFormValues, serverScope: ServerScope) {
    if (!isCurrentServer(serverScope)) {
      toast({
        title: 'Server connection changed',
        description: 'Review the sample, then add it again.',
        variant: 'destructive',
      });
      return;
    }
    if (pendingUpload.current) return;
    const request = Symbol('sample upload');
    pendingUpload.current = request;
    const revision = uploadRevision.current;
    const isCurrent = () =>
      uploadRevision.current === revision &&
      isCurrentServer(serverScope) &&
      currentContext.current.open &&
      currentContext.current.profileId === profileId &&
      form.getValues('file') === data.file &&
      form.getValues('referenceText') === data.referenceText;
    try {
      await addSample.mutateAsync({
        profileId,
        file: data.file,
        referenceText: data.referenceText,
        _serverScope: serverScope,
      });

      if (!isCurrent()) return;
      toast({ title: 'Sample added' });

      handleOpenChange(false);
    } catch (error) {
      if (!isCurrent()) return;
      toast({
        title: 'Could not add sample',
        description:
          error instanceof Error ? error.message : 'Check the audio and transcript, then retry.',
        variant: 'destructive',
      });
    } finally {
      if (pendingUpload.current === request) pendingUpload.current = null;
    }
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      transcriptionRevision.current += 1;
      uploadRevision.current += 1;
      pendingUpload.current = null;
    }
    onOpenChange(newOpen);
  }

  function handleCancelRecording() {
    if (mode === 'record') {
      cancelRecording();
    } else if (mode === 'system') {
      cancelSystemRecording();
    }
    form.resetField('file');
    cleanupAudio();
  }

  function handlePlayPause() {
    const file = form.getValues('file');
    playPause(file);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Audio Sample</DialogTitle>
          <DialogDescription>
            Upload an audio file and provide the reference text that matches the audio.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={(event) => {
            const scope = currentServerScope();
            return form.handleSubmit((data) => onSubmit(data, scope))(event);
          }} className="space-y-4">
            <Tabs
              value={mode}
              onValueChange={(v) => {
                const nextMode = v as 'upload' | 'record' | 'system';
                if ((isRecording || isStarting) && nextMode !== 'record') cancelRecording();
                if (isSystemRecording && nextMode !== 'system') cancelSystemRecording();
                setMode(nextMode);
              }}
            >
              <TabsList
                className={`grid w-full ${platform.metadata.isTauri && isSystemAudioSupported ? 'grid-cols-3' : 'grid-cols-2'}`}
              >
                <TabsTrigger value="upload" className="flex items-center gap-2">
                  <Upload className="h-4 w-4 shrink-0" />
                  Upload
                </TabsTrigger>
                <TabsTrigger value="record" className="flex items-center gap-2">
                  <Mic className="h-4 w-4 shrink-0" />
                  Record
                </TabsTrigger>
                {platform.metadata.isTauri && isSystemAudioSupported && (
                  <TabsTrigger value="system" className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 shrink-0" />
                    System Audio
                  </TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="upload" className="space-y-4">
                <FormField
                  control={form.control}
                  name="file"
                  render={({ field: { onChange, name } }) => (
                    <AudioSampleUpload
                      file={selectedFile}
                      onFileChange={onChange}
                      onTranscribe={handleTranscribe}
                      onPlayPause={handlePlayPause}
                      isPlaying={isPlaying}
                      isTranscribing={transcribe.isPending}
                      fieldName={name}
                    />
                  )}
                />
              </TabsContent>

              <TabsContent value="record" className="space-y-4">
                <FormField
                  control={form.control}
                  name="file"
                  render={() => (
                    <AudioSampleRecording
                      file={selectedFile}
                      isRecording={isRecording}
                      isStarting={isStarting}
                      recordingStream={recordingStream}
                      usingDefaultMicrophone={usingDefaultMicrophone}
                      duration={duration}
                      onStart={startRecording}
                      onStop={stopRecording}
                      onCancel={handleCancelRecording}
                      onTranscribe={handleTranscribe}
                      onPlayPause={handlePlayPause}
                      isPlaying={isPlaying}
                      isTranscribing={transcribe.isPending}
                    />
                  )}
                />
              </TabsContent>

              {platform.metadata.isTauri && isSystemAudioSupported && (
                <TabsContent value="system" className="space-y-4">
                  <FormField
                    control={form.control}
                    name="file"
                    render={() => (
                      <AudioSampleSystem
                        file={selectedFile}
                        isRecording={isSystemRecording}
                        duration={systemDuration}
                        onStart={startSystemRecording}
                        onStop={stopSystemRecording}
                        onCancel={handleCancelRecording}
                        onTranscribe={handleTranscribe}
                        onPlayPause={handlePlayPause}
                        isPlaying={isPlaying}
                        isTranscribing={transcribe.isPending}
                      />
                    )}
                  />
                </TabsContent>
              )}
            </Tabs>

            <FormField
              control={form.control}
              name="referenceText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reference Text</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Enter the exact text spoken in the audio..."
                      className="min-h-[100px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {open && selectedFile && (
              <SampleQuality
                file={selectedFile}
                referenceText={form.watch('referenceText') ?? ''}
                language={profile?.language}
              />
            )}

            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addSample.isPending}>
                {addSample.isPending ? 'Uploading...' : 'Add Sample'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
