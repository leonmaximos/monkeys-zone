import { create } from 'zustand';
import type { ChatMessage, Room, Server, Session } from './contracts';

export type Connection =
  'offline' | 'connecting' | 'online' | 'reconnecting' | 'replaced';
export interface PendingMessage {
  client_id: string;
  server_id: string;
  content: string;
  state: 'sending' | 'failed';
  error?: string;
}
interface State {
  session: Session | null;
  servers: Server[];
  room: Room | null;
  messages: ChatMessage[];
  pending: PendingMessage[];
  connection: Connection;
  error: string;
  notices: string[];
  nextBefore: number | null;
}
export const useAppStore = create<State>(() => ({
  session: null,
  servers: [],
  room: null,
  messages: [],
  pending: [],
  connection: 'offline',
  error: '',
  notices: [],
  nextBefore: null,
}));
export function mergeMessages(incoming: ChatMessage[]) {
  useAppStore.setState((state) => {
    const messages = new Map(
      state.messages.map((message) => [message.id, message]),
    );
    for (const message of incoming)
      if (message.server_id === state.room?.server_id)
        messages.set(message.id, message);
    const confirmed = new Set(
      incoming.map((m) => `${m.sender_id}:${m.client_id}`),
    );
    return {
      messages: [...messages.values()].sort((a, b) => a.id - b.id),
      pending: state.pending.filter(
        (p) => !confirmed.has(`${state.session?.id}:${p.client_id}`),
      ),
    };
  });
}
