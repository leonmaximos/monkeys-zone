import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MeshVoice, type VoiceSnapshot } from './mesh';

const stop = vi.fn();
const track = { stop, enabled: true, onended: null as (() => void) | null };
const stream = {
  getTracks: () => [track],
  getAudioTracks: () => [track],
} as unknown as MediaStream;
const own = {
  id: 'self',
  display_name: 'Ana',
  connected: true,
  in_voice: true,
  muted: false,
};
const send = vi.fn(() => true);
const states: VoiceSnapshot[] = [];
beforeEach(() => {
  stop.mockClear();
  send.mockClear();
  states.length = 0;
  track.enabled = true;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('entra explicitamente, aplica mute na track e sai encerrando o microfone', async () => {
  const mesh = new MeshVoice('self', { send }, (state) => states.push(state));
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  mesh.sync([own]);
  await mesh.join('', '', async () => ({ iceServers: [] }));
  expect(send).toHaveBeenCalledWith({ type: 'voice_join' });
  expect(states.at(-1)?.status).toBe('active');
  mesh.mute(true);
  expect(track.enabled).toBe(false);
  expect(send).toHaveBeenCalledWith({ type: 'mute', muted: true });
  mesh.mute(false);
  expect(track.enabled).toBe(true);
  mesh.leave();
  expect(stop).toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith({ type: 'voice_leave' });
  expect(states.at(-1)?.status).toBe('off');
});
it('fecha conexões e elementos de reprodução ao sair', async () => {
  const close = vi.fn();
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      connectionState = 'new';
      close = close;
      addTrack = vi.fn();
    },
  );
  const mesh = new MeshVoice('self', { send }, (state) => states.push(state));
  mesh.sync([own, { ...own, id: 'remote' }]);
  await mesh.join('', '', async () => ({ iceServers: [] }));
  expect(document.querySelectorAll('audio')).toHaveLength(1);
  mesh.leave();
  expect(close).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll('audio')).toHaveLength(0);
  vi.unstubAllGlobals();
});
it('encerra stream pendente quando o usuário sai durante a permissão', async () => {
  let resolve: ((stream: MediaStream) => void) | undefined;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const mesh = new MeshVoice('self', { send }, (state) => states.push(state));
  const joining = mesh.join('', '', async () => ({ iceServers: [] }));
  mesh.leave();
  resolve?.(stream);
  await joining;
  expect(stop).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalledWith({ type: 'voice_join' });
});

it('libera o microfone quando não recebe confirmação de entrada na voz', async () => {
  vi.useFakeTimers();
  const mesh = new MeshVoice('self', { send }, (state) => states.push(state));
  await mesh.join('', '', async () => ({ iceServers: [] }));
  await vi.advanceTimersByTimeAsync(10000);
  expect(stop).toHaveBeenCalled();
  expect(states.at(-1)?.status).toBe('off');
  expect(states.at(-1)?.error).toContain('não confirmou');
});

it('aguarda o iniciador do par e preserva ICE recebido antes da descrição', async () => {
  const peers: FakePeer[] = [];
  class FakePeer {
    connectionState = 'new';
    signalingState = 'stable';
    remoteDescription: RTCSessionDescriptionInit | null = null;
    localDescription: RTCSessionDescriptionInit | null = null;
    onnegotiationneeded: (() => Promise<void>) | null = null;
    addTrack = vi.fn();
    close = vi.fn();
    addIceCandidate = vi.fn(async () => {});
    setRemoteDescription = vi.fn(
      async (description: RTCSessionDescriptionInit) => {
        this.remoteDescription = description;
        this.signalingState = 'have-remote-offer';
      },
    );
    setLocalDescription = vi.fn(async () => {
      this.localDescription = { type: 'answer', sdp: 'v=0' };
      this.signalingState = 'stable';
    });
    constructor() {
      peers.push(this);
    }
  }
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  const mesh = new MeshVoice('z', { send }, (state) => states.push(state));
  mesh.sync([
    { ...own, id: 'z' },
    { ...own, id: 'a' },
  ]);
  await mesh.join('', '', async () => ({ iceServers: [] }));
  const peer = peers[0];
  if (!peer) throw new Error('Peer não criado');
  await peer.onnegotiationneeded?.();
  expect(peer.setLocalDescription).not.toHaveBeenCalled();
  const candidate = { candidate: 'candidate:test', usernameFragment: 'remote' };
  mesh.receive('a', { kind: 'candidate', candidate });
  mesh.receive('a', {
    kind: 'description',
    description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:remote\r\n' },
  });
  await vi.waitFor(() =>
    expect(peer.addIceCandidate).toHaveBeenCalledWith(candidate),
  );
  expect(peer.setLocalDescription).toHaveBeenCalledTimes(1);
  mesh.leave();
  vi.unstubAllGlobals();
});
