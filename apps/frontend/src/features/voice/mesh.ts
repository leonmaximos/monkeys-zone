import { audioConstraints, mediaError } from '../audio/devices';
import type { Participant, Signal } from '@/lib/contracts';

export interface VoiceSnapshot {
  status: 'off' | 'joining' | 'active';
  muted: boolean;
  error: string;
  peers: Record<string, RTCPeerConnectionState>;
  playbackBlocked: boolean;
}
interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  queue: Promise<void>;
  restartCount: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}
interface Transport {
  send: (
    event:
      | { type: 'voice_join' | 'voice_leave' }
      | { type: 'mute'; muted: boolean }
      | { type: 'signal'; to: string; signal: Signal },
  ) => boolean;
}

export class MeshVoice {
  private stream: MediaStream | null = null;
  private peers = new Map<string, Peer>();
  private participants: Participant[] = [];
  private iceServers: RTCIceServer[] = [];
  private output = '';
  private generation = 0;
  private joinTimeout: ReturnType<typeof setTimeout> | undefined;
  private snapshot: VoiceSnapshot = {
    status: 'off',
    muted: false,
    error: '',
    peers: {},
    playbackBlocked: false,
  };
  constructor(
    private self: string,
    private transport: Transport,
    private update: (value: VoiceSnapshot) => void,
  ) {}
  private publish(patch: Partial<VoiceSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      peers: Object.fromEntries(
        [...this.peers].map(([id, p]) => [id, p.pc.connectionState]),
      ),
    };
    this.update(this.snapshot);
  }
  async join(
    inputId: string,
    outputId: string,
    configuration: () => Promise<{ iceServers: RTCIceServer[] }>,
  ) {
    if (this.snapshot.status !== 'off') return;
    this.publish({ status: 'joining', error: '', muted: false });
    const generation = ++this.generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        audioConstraints(inputId),
      );
      if (generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      this.output = outputId;
      const config = await configuration();
      if (generation !== this.generation) return;
      this.iceServers = config.iceServers;
      stream.getAudioTracks().forEach((track) => {
        track.onended = () =>
          this.leave(
            'Microfone desconectado. Entre na voz novamente após selecionar um dispositivo.',
          );
      });
      if (!this.transport.send({ type: 'voice_join' }))
        throw new Error('A conexão com o servidor foi perdida.');
      this.joinTimeout = setTimeout(() => {
        if (
          generation === this.generation &&
          this.snapshot.status === 'joining'
        )
          this.leave(
            'O servidor não confirmou a entrada na voz. Tente novamente.',
          );
      }, 10000);
      // Conexões só são criadas após o snapshot confirmar a autorização de voz.
      this.sync(this.participants);
    } catch (error) {
      if (generation === this.generation)
        this.leave(
          error instanceof DOMException || !navigator.mediaDevices
            ? mediaError(error)
            : error instanceof Error
              ? error.message
              : 'Falha ao entrar na voz.',
        );
    }
  }
  sync(participants: Participant[]) {
    this.participants = participants;
    if (!this.stream) return;
    const own = participants.find((p) => p.id === this.self);
    if (!own?.in_voice) {
      if (this.snapshot.status === 'active') this.leave();
      return;
    }
    const remote = participants.filter(
      (p) => p.id !== this.self && p.in_voice && p.connected,
    );
    for (const id of this.peers.keys())
      if (!remote.some((p) => p.id === id)) this.closePeer(id);
    for (const participant of remote)
      if (!this.peers.has(participant.id)) this.createPeer(participant.id);
    clearTimeout(this.joinTimeout);
    this.publish({ status: 'active' });
  }
  private createPeer(id: string) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.peerId = id;
    audio.setAttribute('aria-label', 'Áudio remoto');
    document.body.append(audio);
    const peer: Peer = {
      pc,
      audio,
      polite: this.self > id,
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      candidates: [],
      queue: Promise.resolve(),
      restartCount: 0,
    };
    this.peers.set(id, peer);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        this.transport.send({
          type: 'signal',
          to: id,
          signal: { kind: 'candidate', candidate: candidate.toJSON() },
        });
    };
    pc.ontrack = ({ streams, track }) => {
      if (this.peers.get(id) !== peer) return;
      audio.srcObject = streams[0] ?? new MediaStream([track]);
      void this.applyOutput(audio)
        .then(() => audio.play())
        .catch(() => this.publish({ playbackBlocked: true }));
    };
    pc.onnegotiationneeded = async () => {
      // Um iniciador por par evita glare na primeira conexão. Perfect negotiation
      // continua tratando colisões em renegociações/restarts de ICE.
      if (this.self > id && pc.remoteDescription === null) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (this.peers.get(id) === peer && pc.localDescription)
          this.transport.send({
            type: 'signal',
            to: id,
            signal: {
              kind: 'description',
              description: {
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp,
              },
            },
          });
      } catch {
        if (pc.signalingState !== 'closed')
          this.publish({
            error:
              'Falha na negociação de áudio. Saia e entre na voz para tentar novamente.',
          });
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== peer) return;
      clearTimeout(peer.disconnectTimer);
      if (pc.connectionState === 'failed') {
        if (peer.restartCount++ < 1) pc.restartIce();
        else
          this.publish({
            error:
              'Não foi possível conectar a um participante. A rede pode exigir TURN.',
          });
      }
      if (pc.connectionState === 'disconnected')
        peer.disconnectTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') pc.restartIce();
        }, 8000);
      this.publish();
    };
    const stream = this.stream;
    stream?.getTracks().forEach((track) => pc.addTrack(track, stream));
    return peer;
  }
  receive(from: string, signal: Signal) {
    if (
      !this.stream ||
      !this.participants.some((p) => p.id === this.self && p.in_voice) ||
      !this.participants.some((p) => p.id === from && p.in_voice && p.connected)
    )
      return;
    const peer = this.peers.get(from) ?? this.createPeer(from);
    peer.queue = peer.queue
      .then(async () => {
        if (this.peers.get(from) !== peer) return;
        const pc = peer.pc;
        if (signal.kind === 'description') {
          const description = signal.description;
          const ready =
            !peer.makingOffer &&
            (pc.signalingState === 'stable' || peer.settingAnswer);
          const collision = description.type === 'offer' && !ready;
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return;
          peer.settingAnswer = description.type === 'answer';
          await pc.setRemoteDescription(description);
          peer.settingAnswer = false;
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            if (pc.localDescription)
              this.transport.send({
                type: 'signal',
                to: from,
                signal: {
                  kind: 'description',
                  description: {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp,
                  },
                },
              });
          }
          for (const candidate of peer.candidates.splice(0))
            await this.addCandidate(peer, candidate);
        } else {
          // Uma oferta ignorada pode reutilizar as credenciais ICE na resposta.
          // Preserve candidates até a descrição aceita em vez de descartá-los.
          if (!pc.remoteDescription || peer.ignoreOffer) {
            if (peer.candidates.length < 128)
              peer.candidates.push(signal.candidate);
          } else await this.addCandidate(peer, signal.candidate);
        }
      })
      .catch(() => {
        if (peer.pc.signalingState !== 'closed')
          this.publish({
            error:
              'Falha ao negociar a conexão. Verifique a rede ou tente entrar na voz novamente.',
          });
      });
  }
  private async addCandidate(peer: Peer, candidate: RTCIceCandidateInit) {
    const remote = peer.pc.remoteDescription?.sdp ?? '';
    const fragments = [...remote.matchAll(/^a=ice-ufrag:([^\r\n]+)/gm)].map(
      (match) => match[1],
    );
    if (
      candidate.usernameFragment &&
      fragments.length &&
      !fragments.includes(candidate.usernameFragment)
    )
      return;
    await peer.pc.addIceCandidate(candidate);
  }
  mute(muted: boolean) {
    if (!this.stream || this.snapshot.status !== 'active') return;
    this.stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.publish({ muted });
    if (!this.transport.send({ type: 'mute', muted }))
      this.leave('Conexão perdida. A captura de áudio foi encerrada.');
  }
  async setOutput(output: string) {
    this.output = output;
    try {
      await Promise.all(
        [...this.peers.values()].map((peer) => this.applyOutput(peer.audio)),
      );
    } catch {
      this.publish({
        error:
          'Não foi possível selecionar a saída de áudio. Verifique as permissões do dispositivo.',
      });
    }
  }
  private async applyOutput(audio: HTMLAudioElement) {
    if ('setSinkId' in audio) await audio.setSinkId(this.output);
  }
  async resumePlayback() {
    try {
      await Promise.all(
        [...this.peers.values()].map((peer) => peer.audio.play()),
      );
      this.publish({ playbackBlocked: false });
    } catch {
      this.publish({
        error:
          'Reprodução de áudio bloqueada pelo navegador. Interaja com a página e tente novamente.',
      });
    }
  }
  leave(error = '') {
    this.generation += 1;
    clearTimeout(this.joinTimeout);
    this.transport.send({ type: 'voice_leave' });
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.stream = null;
    for (const id of this.peers.keys()) this.closePeer(id);
    this.publish({
      status: 'off',
      muted: false,
      error,
      playbackBlocked: false,
    });
  }
  private closePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.disconnectTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
    peer.audio.remove();
  }
}
