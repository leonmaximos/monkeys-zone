import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioSetup } from './AudioSetup';
import { MicrophoneTest } from './devices';

const stop = vi.fn();
const close = vi.fn(async () => {});
const track = { stop, enabled: true, onended: null };
const stream = {
  getTracks: () => [track],
  getAudioTracks: () => [track],
} as unknown as MediaStream;
beforeEach(() => {
  localStorage.clear();
  stop.mockClear();
  close.mockClear();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn(async () => stream),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      resume = async () => {};
      close = close;
      createMediaStreamSource = () => ({ connect: vi.fn() });
      createAnalyser = () => ({
        fftSize: 512,
        getByteTimeDomainData: (data: Uint8Array) => data.fill(160),
      });
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
it('não captura automaticamente e libera tracks e contexto ao parar', async () => {
  const { unmount } = render(<AudioSetup />);
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Testar microfone' }));
  await screen.findByText(/Fale e observe o nível/);
  expect(screen.getByLabelText('Volume do microfone')).toHaveAttribute(
    'value',
    '1',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Parar teste' }));
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  unmount();
});
it('informa permissão negada sem bloquear o uso de texto', async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
    new DOMException('denied', 'NotAllowedError'),
  );
  render(<AudioSetup />);
  fireEvent.click(screen.getByRole('button', { name: 'Testar microfone' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Permissão de microfone negada',
  );
});
it('encerra captura que chega depois da desmontagem', async () => {
  let resolve: ((stream: MediaStream) => void) | undefined;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const meter = new MicrophoneTest();
  const running = meter.start('', vi.fn(), vi.fn());
  meter.stop();
  resolve?.(stream);
  expect(await running).toBe(false);
  expect(stop).toHaveBeenCalled();
});
it('trata ausência de microfone e alteração da lista de dispositivos', async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
    new DOMException('none', 'NotFoundError'),
  );
  render(<AudioSetup />);
  fireEvent.click(screen.getByRole('button', { name: 'Testar microfone' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Nenhum microfone encontrado',
    ),
  );
});
