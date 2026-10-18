export interface AudioPreferences {
  displayName: string;
  inputId: string;
  outputId: string;
}
const key = 'communication-audio-preferences-v1';
export function readPreferences(): AudioPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (typeof value === 'object' && value !== null) {
      const field = (name: string) =>
        name in value && typeof Reflect.get(value, name) === 'string'
          ? String(Reflect.get(value, name))
          : '';
      return {
        displayName: field('displayName'),
        inputId: field('inputId'),
        outputId: field('outputId'),
      };
    }
  } catch {
    /* O navegador pode desabilitar armazenamento local. */
  }
  return { displayName: '', inputId: '', outputId: '' };
}
export function savePreferences(value: AudioPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Preferências não bloqueiam texto. */
  }
}
export function supportsOutputSelection() {
  return (
    typeof HTMLMediaElement !== 'undefined' &&
    'setSinkId' in HTMLMediaElement.prototype
  );
}
export function audioConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: deviceId
      ? {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
        }
      : { echoCancellation: true, noiseSuppression: true },
    video: false,
  };
}
export function mediaError(error: unknown): string {
  if (!navigator.mediaDevices?.getUserMedia)
    return 'O microfone exige HTTPS ou localhost e um navegador compatível. Você pode continuar pelo texto.';
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError')
      return 'Permissão de microfone negada. Altere a permissão no navegador ou continue pelo texto.';
    if (error.name === 'NotFoundError')
      return 'Nenhum microfone encontrado. Conecte um dispositivo ou continue pelo texto.';
    if (error.name === 'OverconstrainedError')
      return 'O dispositivo selecionado não está disponível. Selecione outro microfone.';
    if (error.name === 'NotReadableError')
      return 'Não foi possível abrir o microfone. Verifique se outro aplicativo o está usando.';
  }
  return 'Falha ao acessar o áudio. Confira o dispositivo e a permissão do navegador.';
}

export class MicrophoneTest {
  private generation = 0;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private frame = 0;
  stop() {
    this.generation += 1;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context) void this.context.close();
    this.context = null;
  }
  async start(
    deviceId: string,
    onLevel: (level: number) => void,
    onEnded: () => void,
  ) {
    this.stop();
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia(
      audioConstraints(deviceId),
    );
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    this.stream = stream;
    try {
      const context = new AudioContext();
      this.context = context;
      await context.resume();
      if (generation !== this.generation) return false;
      const analyzer = context.createAnalyser();
      analyzer.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyzer);
      const data = new Uint8Array(analyzer.fftSize);
      const sample = () => {
        if (generation !== this.generation) return;
        analyzer.getByteTimeDomainData(data);
        const rms = Math.sqrt(
          data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) /
            data.length,
        );
        onLevel(Math.min(1, rms * 4));
        this.frame = requestAnimationFrame(sample);
      };
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          this.stop();
          onEnded();
        };
      });
      sample();
      return true;
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }
}
