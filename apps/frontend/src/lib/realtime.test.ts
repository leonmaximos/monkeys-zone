import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { RealtimeClient, newMessageId } from './realtime';
import { useAppStore } from './store';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('gera UUID de mensagem mesmo quando randomUUID não está disponível no HTTP', () => {
  vi.stubGlobal('crypto', {
    getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
  });
  expect(newMessageId()).toBe('07070707-0707-4707-8707-070707070707');
});
it('detecta conexão sem respostas e sai do estado online para encerrar a voz', async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(api, 'servers').mockResolvedValue([]);
  useAppStore.setState({ room: null, connection: 'offline' });
  const client = new RealtimeClient();
  client.start();
  const first = sockets[0];
  if (!first) throw new Error('Socket não criado');
  first.onmessage?.({
    data: '{"v":1,"type":"welcome","session_id":"self","room":null,"grace_seconds":20}',
  });
  expect(useAppStore.getState().connection).toBe('online');
  await vi.advanceTimersByTimeAsync(30000);
  expect(first.close).toHaveBeenCalled();
  expect(sockets).toHaveLength(2);
  expect(useAppStore.getState().connection).toBe('connecting');
  client.stop();
});
