import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { api, ApiError } from './lib/api';
import { useAppStore } from './lib/store';
import { realtime } from './lib/realtime';

vi.mock('@/lib/realtime', () => ({
  realtime: {
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    refreshServers: vi.fn(),
    send: vi.fn(() => true),
    sendMessage: vi.fn(),
    loadHistory: vi.fn(),
    onSignal: vi.fn(() => () => {}),
  },
}));
const session = {
  id: 'session-a',
  display_name: 'Ana Maria',
  expires_at: Date.now() + 1000000,
};
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  useAppStore.setState({
    session: null,
    room: null,
    servers: [],
    messages: [],
    pending: [],
    notices: [],
    connection: 'online',
    error: '',
    nextBefore: null,
  });
  vi.spyOn(api, 'session').mockRejectedValue(
    new ApiError(401, 'unauthorized', 'Identifique-se'),
  );
  vi.spyOn(api, 'servers').mockResolvedValue([]);
});
it('identifica com nome normalizado e permite continuar sem microfone', async () => {
  const identify = vi.spyOn(api, 'identify').mockResolvedValue(session);
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled(),
  );
  expect(
    screen.getByText(/Você pode continuar sem microfone/),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Nome de exibição'), {
    target: { value: '  Ana   Maria  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  await screen.findByRole('heading', { name: 'Servidores públicos' });
  expect(identify).toHaveBeenCalledWith('Ana Maria');
  expect(realtime.start).toHaveBeenCalled();
});
it('rejeita nome curto antes de chamar a API', async () => {
  const identify = vi.spyOn(api, 'identify');
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('Nome de exibição'), {
    target: { value: 'a' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('entre 2 e 32');
  expect(identify).not.toHaveBeenCalled();
});
it('recupera a sessão do cookie sem autenticar pelo armazenamento local', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(session);
  render(<App />);
  await waitFor(() =>
    expect(screen.getByLabelText('Nome de exibição')).toHaveValue('Ana Maria'),
  );
  expect(screen.getByLabelText('Nome de exibição')).toBeDisabled();
});
