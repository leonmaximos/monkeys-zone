export interface Session {
  id: string;
  display_name: string;
  expires_at: number;
}
export interface Server {
  id: string;
  name: string;
  creator_id: string;
  created_at: number;
  participants: number;
  capacity: number;
}
export interface Participant {
  id: string;
  display_name: string;
  connected: boolean;
  in_voice: boolean;
  muted: boolean;
}
export interface Room {
  server_id: string;
  participants: Participant[];
}
export interface ChatMessage {
  id: number;
  client_id: string;
  server_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  created_at: number;
}
export interface History {
  messages: ChatMessage[];
  next_before: number | null;
}
export type Signal =
  | { kind: 'description'; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit };
export type ClientEvent =
  | { type: 'join'; server_id: string }
  | { type: 'leave' | 'heartbeat' | 'voice_join' | 'voice_leave' }
  | { type: 'message'; client_id: string; content: string }
  | { type: 'mute'; muted: boolean }
  | { type: 'signal'; to: string; signal: Signal };
export type ServerEvent =
  | {
      type: 'welcome';
      session_id: string;
      room: Room | null;
      grace_seconds: number;
    }
  | { type: 'joined' | 'presence'; room: Room }
  | { type: 'left' | 'servers_changed' | 'pong' | 'replaced' | 'shutdown' }
  | { type: 'message' | 'ack'; message: ChatMessage }
  | { type: 'notice'; server_id: string; display_name: string; action: string }
  | { type: 'signal'; from: string; signal: Signal }
  | { type: 'error'; code: string; message: string; client_id: string | null };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const strings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === 'string');
function room(value: unknown): value is Room {
  return (
    object(value) &&
    typeof value.server_id === 'string' &&
    Array.isArray(value.participants) &&
    value.participants.length <= 5 &&
    value.participants.every(
      (p: unknown) =>
        object(p) &&
        strings(p, ['id', 'display_name']) &&
        ['connected', 'in_voice', 'muted'].every(
          (key) => typeof p[key] === 'boolean',
        ),
    )
  );
}
function message(value: unknown): value is ChatMessage {
  return (
    object(value) &&
    strings(value, [
      'client_id',
      'server_id',
      'sender_id',
      'sender_name',
      'content',
    ]) &&
    Number.isSafeInteger(value.id) &&
    typeof value.created_at === 'number'
  );
}
export function parseServerEvent(raw: string): ServerEvent {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.v !== 1 || typeof value.type !== 'string')
    throw new Error('Protocolo incompatível.');
  let valid = false;
  switch (value.type) {
    case 'welcome':
      valid =
        typeof value.session_id === 'string' &&
        (value.room === null || room(value.room)) &&
        typeof value.grace_seconds === 'number';
      break;
    case 'joined':
    case 'presence':
      valid = room(value.room);
      break;
    case 'message':
    case 'ack':
      valid = message(value.message);
      break;
    case 'error':
      valid =
        strings(value, ['code', 'message']) &&
        (value.client_id === null || typeof value.client_id === 'string');
      break;
    case 'notice':
      valid = strings(value, ['server_id', 'display_name', 'action']);
      break;
    case 'signal':
      valid =
        typeof value.from === 'string' &&
        object(value.signal) &&
        ((value.signal.kind === 'description' &&
          object(value.signal.description) &&
          ['offer', 'answer'].includes(String(value.signal.description.type)) &&
          typeof value.signal.description.sdp === 'string') ||
          (value.signal.kind === 'candidate' &&
            object(value.signal.candidate) &&
            typeof value.signal.candidate.candidate === 'string'));
      break;
    case 'left':
    case 'servers_changed':
    case 'pong':
    case 'replaced':
    case 'shutdown':
      valid = true;
      break;
  }
  if (!valid) throw new Error('Evento inválido recebido.');
  // A união é validada acima antes de entrar no estado da aplicação.
  return value as unknown as ServerEvent;
}
