import { api, apiBase, errorMessage } from './api';
import { parseServerEvent, type ClientEvent, type Signal } from './contracts';
import { mergeMessages, useAppStore } from './store';

export function newMessageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues também funciona no HTTP de uma LAN; texto não exige microfone.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private historyGeneration = 0;
  private signals = new Set<(from: string, signal: Signal) => void>();
  private refreshRunning = false;
  private refreshAgain = false;
  private networkOffline = () => {
    this.socket?.close();
    useAppStore.setState({ connection: 'reconnecting' });
  };
  private networkOnline = () => this.restart();

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    window.addEventListener('offline', this.networkOffline);
    window.addEventListener('online', this.networkOnline);
    this.connect();
  }
  restart() {
    this.stop();
    this.start();
  }
  stop() {
    this.stopped = true;
    this.generation += 1;
    this.historyGeneration += 1;
    window.removeEventListener('offline', this.networkOffline);
    window.removeEventListener('online', this.networkOnline);
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
  }
  send(event: ClientEvent): boolean {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      useAppStore.getState().connection !== 'online'
    )
      return false;
    this.socket.send(JSON.stringify({ v: 1, ...event }));
    return true;
  }
  onSignal(listener: (from: string, signal: Signal) => void) {
    this.signals.add(listener);
    return () => {
      this.signals.delete(listener);
    };
  }
  async refreshServers() {
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }
    this.refreshRunning = true;
    do {
      this.refreshAgain = false;
      try {
        useAppStore.setState({ servers: await api.servers() });
      } catch (error) {
        useAppStore.setState({ error: errorMessage(error) });
      }
    } while (this.refreshAgain && !this.stopped);
    this.refreshRunning = false;
  }
  async loadHistory(before?: number) {
    const id = useAppStore.getState().room?.server_id;
    const generation = this.historyGeneration;
    if (!id) return;
    try {
      const history = await api.history(id, before);
      if (
        useAppStore.getState().room?.server_id !== id ||
        generation !== this.historyGeneration
      )
        return;
      mergeMessages(history.messages);
      if (!before && useAppStore.getState().nextBefore !== null) return;
      useAppStore.setState({ nextBefore: history.next_before });
    } catch (error) {
      if (useAppStore.getState().room?.server_id === id)
        useAppStore.setState({ error: errorMessage(error) });
    }
  }
  sendMessage(content: string, clientId: string = newMessageId()) {
    const state = useAppStore.getState();
    if (!state.room) return;
    const pending = {
      client_id: clientId,
      server_id: state.room.server_id,
      content,
      state: 'sending' as const,
    };
    useAppStore.setState({
      pending: [
        ...state.pending.filter((p) => p.client_id !== clientId),
        pending,
      ],
    });
    if (!this.send({ type: 'message', client_id: clientId, content }))
      this.fail(clientId, 'Conexão indisponível. Tente novamente.');
    setTimeout(() => {
      if (
        useAppStore
          .getState()
          .pending.some(
            (p) => p.client_id === clientId && p.state === 'sending',
          )
      )
        this.fail(
          clientId,
          'Sem confirmação. Você pode reenviar com segurança.',
        );
    }, 10000);
  }
  private fail(id: string, error: string) {
    useAppStore.setState((state) => ({
      pending: state.pending.map((p) =>
        p.client_id === id ? { ...p, state: 'failed', error } : p,
      ),
    }));
  }
  private connect() {
    const generation = ++this.generation;
    useAppStore.setState({
      connection: this.attempt ? 'reconnecting' : 'connecting',
    });
    const url = new URL(`${apiBase}/api/ws`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    let lastMessage = Date.now();
    this.socket = socket;
    socket.onmessage = (message: MessageEvent<unknown>) => {
      if (generation !== this.generation || typeof message.data !== 'string')
        return;
      try {
        const event = parseServerEvent(message.data);
        lastMessage = Date.now();
        switch (event.type) {
          case 'welcome': {
            this.historyGeneration += 1;
            this.attempt = 0;
            const previous = useAppStore.getState().room?.server_id;
            useAppStore.setState({
              connection: 'online',
              room: event.room,
              messages: [],
              nextBefore: null,
              ...(previous !== event.room?.server_id
                ? { pending: [], notices: [] }
                : {}),
            });
            void this.refreshServers();
            void this.loadHistory();
            // Reenvio idempotente somente para a sala restaurada pelo servidor.
            for (const pending of useAppStore.getState().pending)
              if (pending.server_id === event.room?.server_id)
                this.sendMessage(pending.content, pending.client_id);
            clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
              if (Date.now() - lastMessage >= 30000) {
                this.restart();
                return;
              }
              this.send({ type: 'heartbeat' });
            }, 10000);
            break;
          }
          case 'joined':
            this.historyGeneration += 1;
            useAppStore.setState({
              room: event.room,
              messages: [],
              pending: [],
              notices: [],
              nextBefore: null,
              error: '',
            });
            void this.loadHistory();
            break;
          case 'presence':
            if (useAppStore.getState().room?.server_id === event.room.server_id)
              useAppStore.setState({ room: event.room });
            break;
          case 'left':
            this.historyGeneration += 1;
            useAppStore.setState({
              room: null,
              messages: [],
              pending: [],
              notices: [],
              nextBefore: null,
            });
            void this.refreshServers();
            break;
          case 'servers_changed':
            void this.refreshServers();
            break;
          case 'message':
          case 'ack':
            mergeMessages([event.message]);
            break;
          case 'error':
            if (event.client_id) this.fail(event.client_id, event.message);
            else useAppStore.setState({ error: event.message });
            break;
          case 'notice': {
            const action: Record<string, string> = {
              joined: 'entrou no servidor',
              left: 'saiu do servidor',
              disconnected: 'perdeu a conexão; vaga reservada por 20 s',
            };
            if (event.server_id === useAppStore.getState().room?.server_id)
              useAppStore.setState((state) => ({
                notices: [
                  ...state.notices.slice(-19),
                  `${event.display_name} ${action[event.action] ?? event.action}.`,
                ],
              }));
            break;
          }
          case 'signal':
            for (const listener of this.signals)
              listener(event.from, event.signal);
            break;
          case 'replaced':
            this.stop();
            useAppStore.setState({
              connection: 'replaced',
              room: null,
              messages: [],
              pending: [],
              notices: [],
              error:
                'Esta sessão foi aberta em outra aba. A outra aba assumiu o controle.',
            });
            break;
          case 'shutdown':
            socket.close();
            break;
          case 'pong':
            break;
        }
      } catch {
        useAppStore.setState({
          error: 'O servidor enviou um evento incompatível.',
        });
        socket.close();
      }
    };
    socket.onclose = () => {
      if (generation !== this.generation || this.stopped) return;
      clearInterval(this.heartbeat);
      useAppStore.setState({ connection: 'reconnecting' });
      if (this.attempt >= 8) {
        this.stop();
        useAppStore.setState({
          connection: 'offline',
          error: 'Não foi possível reconectar. Use o botão Reconectar.',
        });
        return;
      }
      this.retry = setTimeout(
        () => this.connect(),
        Math.min(10000, 500 * 2 ** this.attempt++) + Math.random() * 250,
      );
    };
    socket.onerror = () => socket.close();
  }
}
export const realtime = new RealtimeClient();
