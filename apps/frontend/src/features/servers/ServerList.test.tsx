import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { realtime } from '@/lib/realtime';
import { ServerList } from './ServerList';

vi.mock('@/lib/realtime', () => ({
  realtime: { send: vi.fn(() => true), refreshServers: vi.fn() },
}));
const server = {
  id: 'room-a',
  name: 'Café',
  creator_id: 'creator',
  created_at: 1,
  capacity: 5,
  participants: 2,
};
beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ servers: [], room: null, connection: 'online' });
});
it('lista ocupação e solicita entrada no servidor', async () => {
  vi.spyOn(api, 'servers').mockResolvedValue([server]);
  render(<ServerList />);
  await screen.findByRole('heading', { name: 'Café' });
  expect(screen.getByText(/2\/5 participantes/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(realtime.send).toHaveBeenCalledWith({
    type: 'join',
    server_id: 'room-a',
  });
});
it('marca lotação e impede tentativa pela UI', async () => {
  vi.spyOn(api, 'servers').mockResolvedValue([{ ...server, participants: 5 }]);
  render(<ServerList />);
  expect(await screen.findByRole('button', { name: 'Entrar' })).toBeDisabled();
  expect(screen.getByText(/Lotado/)).toBeInTheDocument();
});
it('cria servidor com nome normalizado', async () => {
  vi.spyOn(api, 'servers').mockResolvedValue([]);
  const create = vi.spyOn(api, 'createServer').mockResolvedValue(server);
  render(<ServerList />);
  await screen.findByText(/Ainda não há servidores/);
  fireEvent.click(screen.getByRole('button', { name: /Criar servidor/ }));
  fireEvent.change(screen.getByLabelText('Nome do servidor'), {
    target: { value: '  Café   Rust ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith('Café Rust'));
  await waitFor(() => expect(realtime.refreshServers).toHaveBeenCalled());
});
it('exibe erro de carregamento e permite tentar novamente', async () => {
  vi.spyOn(api, 'servers').mockRejectedValue(new Error('Sem rede'));
  render(<ServerList />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Sem rede');
  expect(
    screen.getByRole('button', { name: 'Tentar novamente' }),
  ).toBeEnabled();
});
