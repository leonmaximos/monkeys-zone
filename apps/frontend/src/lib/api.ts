import type { History, Server, Session } from './contracts';

export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(
  /\/+$/,
  '',
);
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiBase}/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      throw new ApiError(
        response.status,
        'code' in error && typeof error.code === 'string'
          ? error.code
          : 'request_failed',
        error.message,
      );
    }
    throw new ApiError(
      response.status,
      'request_failed',
      `A operação falhou (HTTP ${response.status}).`,
    );
  }
  return response.json() as Promise<T>;
}
export const api = {
  session: () => request<Session>('/session'),
  identify: (display_name: string) =>
    request<Session>('/session', {
      method: 'POST',
      body: JSON.stringify({ display_name }),
    }),
  servers: () => request<Server[]>('/servers'),
  createServer: (name: string) =>
    request<Server>('/servers', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  history: (id: string, before?: number) =>
    request<History>(
      `/servers/${encodeURIComponent(id)}/messages?limit=50${before ? `&before=${before}` : ''}`,
    ),
  rtcConfig: () =>
    request<{ iceServers: RTCIceServer[]; expiresAt: number }>('/rtc-config'),
};
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Não foi possível concluir a operação.';
export function normalizeName(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}
export function validName(value: string, maximum = 32) {
  const name = normalizeName(value);
  return (
    Array.from(name).length >= 2 &&
    Array.from(name).length <= maximum &&
    !Array.from(name).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}
