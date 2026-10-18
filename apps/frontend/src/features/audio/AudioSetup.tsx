import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  MicrophoneTest,
  mediaError,
  readPreferences,
  savePreferences,
  supportsOutputSelection,
  type AudioPreferences,
} from './devices';

export function AudioSetup({
  onChange,
}: {
  onChange?: (preferences: AudioPreferences) => void;
}) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const meter = useRef(new MicrophoneTest());
  const mounted = useRef(true);
  const generation = useRef(0);
  const enumerate = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError(mediaError(null));
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (mounted.current) setDevices(devices);
    } catch (error) {
      if (mounted.current) setError(mediaError(error));
    }
  };
  useEffect(() => {
    mounted.current = true;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        if (mounted.current) setDevices(devices);
      })
      .catch(() => {
        if (mounted.current)
          setError('Não foi possível listar os dispositivos.');
      });
    const onDeviceChange = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (!mounted.current) return;
          setDevices(devices);
          const current = readPreferences();
          if (
            current.inputId &&
            !devices.some(
              (device) =>
                device.deviceId === current.inputId &&
                device.kind === 'audioinput',
            )
          ) {
            meter.current.stop();
            setTesting(false);
            setBusy(false);
            setLevel(0);
            generation.current += 1;
            const next = { ...current, inputId: '' };
            savePreferences(next);
            setPreferences(next);
            onChange?.(next);
            setError(
              'Microfone desconectado. O dispositivo padrão será usado na próxima entrada na voz.',
            );
          }
          if (
            current.outputId &&
            !devices.some(
              (device) =>
                device.deviceId === current.outputId &&
                device.kind === 'audiooutput',
            )
          ) {
            const next = { ...readPreferences(), outputId: '' };
            savePreferences(next);
            setPreferences(next);
            onChange?.(next);
            setError(
              'Saída de áudio desconectada. A saída padrão será usada na próxima entrada na voz.',
            );
          }
        })
        .catch(() => {
          if (mounted.current) setError('Falha ao atualizar dispositivos.');
        });
    };
    const currentMeter = meter.current;
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);
    return () => {
      mounted.current = false;
      generation.current += 1;
      currentMeter.stop();
      navigator.mediaDevices?.removeEventListener(
        'devicechange',
        onDeviceChange,
      );
    };
  }, [onChange]);
  const change = (field: 'inputId' | 'outputId', value: string) => {
    if (field === 'inputId') {
      meter.current.stop();
      generation.current += 1;
      setTesting(false);
      setBusy(false);
      setLevel(0);
    }
    const next = { ...readPreferences(), [field]: value };
    savePreferences(next);
    setPreferences(next);
    onChange?.(next);
  };
  const toggle = async () => {
    if (testing || busy) {
      meter.current.stop();
      generation.current += 1;
      setTesting(false);
      setBusy(false);
      setLevel(0);
      return;
    }
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const started = await meter.current.start(
        preferences.inputId,
        setLevel,
        () => {
          if (mounted.current) {
            setTesting(false);
            setLevel(0);
            setError('O microfone foi desconectado.');
          }
        },
      );
      if (mounted.current && current === generation.current) {
        setTesting(started);
        await enumerate();
      }
    } catch (error) {
      if (mounted.current && current === generation.current)
        setError(mediaError(error));
    } finally {
      if (mounted.current && current === generation.current) setBusy(false);
    }
  };
  return (
    <fieldset className="audio-setup">
      <legend>Dispositivos de áudio</legend>
      <label>
        Microfone
        <select
          value={preferences.inputId}
          onChange={(event) => change('inputId', event.target.value)}
        >
          <option value="">Dispositivo padrão</option>
          {devices
            .filter((d) => d.kind === 'audioinput' && d.deviceId)
            .map((d, index) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microfone ${index + 1}`}
              </option>
            ))}
        </select>
      </label>
      <label>
        Saída de áudio
        <select
          disabled={!supportsOutputSelection()}
          value={preferences.outputId}
          onChange={(event) => change('outputId', event.target.value)}
        >
          <option value="">Saída padrão do sistema</option>
          {devices
            .filter((d) => d.kind === 'audiooutput' && d.deviceId)
            .map((d, index) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Saída ${index + 1}`}
              </option>
            ))}
        </select>
      </label>
      {!supportsOutputSelection() && (
        <p className="hint">
          Este navegador usa a saída padrão do sistema e não permite selecionar
          outra saída aqui.
        </p>
      )}
      <Button
        type="button"
        onClick={() => void toggle()}
        disabled={!navigator.mediaDevices?.getUserMedia}
      >
        {testing || busy ? 'Parar teste' : 'Testar microfone'}
      </Button>
      <meter aria-label="Volume do microfone" min={0} max={1} value={level} />
      <p className="hint">
        {testing
          ? 'Fale e observe o nível. O teste não transmite nem reproduz sua voz.'
          : 'O microfone só é capturado durante o teste ou quando você entra na voz.'}
      </p>
      {!navigator.mediaDevices && (
        <p role="status">
          Áudio indisponível neste contexto. Use HTTPS ou localhost; o texto
          continua disponível.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
