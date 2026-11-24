import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  isMicrophonePermissionDenied,
  microphoneErrorMessage,
  requestMicrophone,
} from '@/lib/utils/microphone';
import { useMicrophoneStore } from '@/stores/microphoneStore';
import { MicrophonePermissionHelp } from './MicrophonePermissionHelp';

const SYSTEM_DEFAULT = 'system-default';

export function MicrophoneSelector({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const { deviceId, deviceLabel, setMicrophone } = useMicrophoneStore();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [enumerationError, setEnumerationError] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<{
    message: string;
    denied: boolean;
  } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const refreshVersion = useRef(0);
  const permissionRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const available = await navigator.mediaDevices.enumerateDevices();
      if (refreshVersion.current !== version) return;
      setDevices(
        available.filter(
          (device) =>
            device.kind === 'audioinput' &&
            device.deviceId &&
            device.deviceId !== 'default' &&
            device.deviceId !== 'communications',
        ),
      );
      setEnumerationError(null);
    } catch (cause) {
      if (refreshVersion.current === version) setEnumerationError(microphoneErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener('devicechange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      ++refreshVersion.current;
      permissionRequest.current?.abort();
      mediaDevices?.removeEventListener('devicechange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const enableMicrophones = async () => {
    if (permissionRequest.current) return;
    const controller = new AbortController();
    permissionRequest.current = controller;
    setRequesting(true);
    setPermissionError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('microphone.noAccess'));
      const stream = await requestMicrophone(navigator.mediaDevices, null, controller.signal);
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      if (!controller.signal.aborted) await refresh();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setPermissionError({
          message: microphoneErrorMessage(cause),
          denied: isMicrophonePermissionDenied(cause),
        });
      }
    } finally {
      if (!controller.signal.aborted) setRequesting(false);
      if (permissionRequest.current === controller) permissionRequest.current = null;
    }
  };

  const error = permissionError?.message ?? enumerationError;
  const selectedUnavailable = deviceId && !devices.some((device) => device.deviceId === deviceId);
  const needsPermission = !devices.some((device) => device.label);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('microphone.label')}</Label>
      <div className="flex items-center gap-2">
        <Select
          value={deviceId || SYSTEM_DEFAULT}
          disabled={disabled || requesting}
          onOpenChange={(open) => {
            if (open) void refresh();
          }}
          onValueChange={(value) => {
            const device = devices.find((input) => input.deviceId === value);
            setMicrophone(value === SYSTEM_DEFAULT ? null : value, device?.label || null);
          }}
        >
          <SelectTrigger id={id} className="min-w-0 flex-1 [&>span]:truncate">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[min(32rem,90vw)]">
            <SelectItem value={SYSTEM_DEFAULT}>{t('microphone.systemDefault')}</SelectItem>
            {selectedUnavailable && (
              <SelectItem value={deviceId} disabled>
                {t('microphone.unavailable', { name: deviceLabel || t('microphone.label') })}
              </SelectItem>
            )}
            {devices.map((device, index) => (
              <SelectItem key={device.deviceId} value={device.deviceId}>
                {device.label || t('microphone.input', { number: index + 1 })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={disabled || requesting}
          onClick={() => void refresh()}
          aria-label={t('microphone.refresh')}
          title={t('microphone.refresh')}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      {needsPermission && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || requesting}
          onClick={() => void enableMicrophones()}
        >
          {requesting ? t('microphone.enabling') : t('microphone.enable')}
        </Button>
      )}
      {permissionError?.denied ? <MicrophonePermissionHelp /> : error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
