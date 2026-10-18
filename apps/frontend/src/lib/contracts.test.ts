import { expect, it } from 'vitest';
import { parseServerEvent } from './contracts';
import { normalizeName, validName } from './api';
import { mergeMessages, useAppStore } from './store';

it('valida nomes por caracteres Unicode e normaliza espaços', () => {
  expect(normalizeName('  Ana   Maria ')).toBe('Ana Maria');
  expect(validName('é😀')).toBe(true);
  expect(validName('a')).toBe(false);
  expect(validName('x'.repeat(33))).toBe(false);
});
it('rejeita eventos inválidos em vez de corromper o estado', () => {
  for (const raw of [
    '{}',
    'not json',
    '{"v":2,"type":"left"}',
    '{"v":1,"type":"presence","room":{}}',
  ])
    expect(() => parseServerEvent(raw)).toThrow();
  expect(parseServerEvent('{"v":1,"type":"left"}').type).toBe('left');
});
it('mescla confirmação e broadcast sem duplicar e mantém ordenação', () => {
  useAppStore.setState({
    session: { id: 'self', display_name: 'Ana', expires_at: 1 },
    room: { server_id: 'room', participants: [] },
    messages: [],
    pending: [
      {
        client_id: 'client',
        server_id: 'room',
        content: 'oi',
        state: 'sending',
      },
    ],
  });
  const message = {
    id: 2,
    client_id: 'client',
    server_id: 'room',
    sender_id: 'self',
    sender_name: 'Ana',
    content: 'oi',
    created_at: 1,
  };
  mergeMessages([message, { ...message, id: 1, client_id: 'other' }]);
  mergeMessages([message]);
  expect(useAppStore.getState().messages.map((m) => m.id)).toEqual([1, 2]);
  expect(useAppStore.getState().pending).toHaveLength(0);
});
