import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAppStore } from '@/lib/store';
import { realtime } from '@/lib/realtime';
import { ServerRoom } from './ServerRoom';

vi.mock('@/lib/realtime', () => ({
  realtime: {
    send: vi.fn(() => true),
    sendMessage: vi.fn(),
    onSignal: vi.fn(() => () => {}),
    loadHistory: vi.fn(),
  },
}));
const session = { id: 'self', display_name: 'Ana', expires_at: 10000000 };
beforeEach(() => {
  useAppStore.setState({
    session,
    room: {
      server_id: 'room',
      participants: [
        {
          id: 'self',
          display_name: 'Ana',
          in_voice: false,
          muted: false,
          connected: true,
        },
      ],
    },
    servers: [
      {
        id: 'room',
        name: 'Café',
        participants: 1,
        capacity: 5,
        creator_id: 'self',
        created_at: 1,
      },
    ],
    connection: 'online',
    messages: [],
    pending: [],
    notices: [],
    nextBefore: null,
  });
});
it('envia composição e aguarda confirmação fora do histórico persistido', () => {
  render(<ServerRoom session={session} />);
  fireEvent.change(screen.getByLabelText('Mensagem'), {
    target: { value: 'Olá mundo' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(realtime.sendMessage).toHaveBeenCalledWith('Olá mundo');
  expect(screen.getByLabelText('Mensagem')).toHaveValue('');
});
it('renderiza conteúdo como texto sem interpretar HTML', () => {
  const payload = '<img src=x onerror=alert(1) />';
  useAppStore.setState({
    messages: [
      {
        id: 1,
        client_id: 'client',
        server_id: 'room',
        sender_id: 'other',
        sender_name: 'Bruno',
        content: payload,
        created_at: 1,
      },
    ],
  });
  const { container } = render(<ServerRoom session={session} />);
  expect(screen.getByText(payload)).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
});
