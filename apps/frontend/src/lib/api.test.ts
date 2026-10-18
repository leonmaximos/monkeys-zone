import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('identifica pela origem atual usando /api/session e cookies do navegador', async () => {
  vi.stubEnv('VITE_API_BASE_URL', '');
  vi.resetModules();
  const session = { id: 'public-id', display_name: 'Ana', expires_at: 123 };
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(session), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./api');
  await expect(api.identify('Ana')).resolves.toEqual(session);
  expect(fetch).toHaveBeenCalledWith('/api/session', {
    method: 'POST',
    body: JSON.stringify({ display_name: 'Ana' }),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
});
