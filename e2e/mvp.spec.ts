import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

async function participant(browser: Browser, name: string) {
  const context = await browser.newContext({
    permissions: ['microphone'],
    baseURL: 'http://127.0.0.1:5173',
  });
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    const operations: unknown[] = [];
    Reflect.set(window, '__testRtcOperations', operations);
    Reflect.set(window, '__testPeers', peers);
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {
      construct(target, args) {
        const pc = Reflect.construct(target, args) as RTCPeerConnection;
        peers.push(pc);
        for (const method of [
          'setLocalDescription',
          'setRemoteDescription',
          'addIceCandidate',
        ]) {
          const original = Reflect.get(pc, method) as (
            ...args: unknown[]
          ) => Promise<void>;
          Reflect.set(pc, method, async (...arguments_: unknown[]) => {
            const details = {
              peer: peers.indexOf(pc),
              method,
              before: pc.signalingState,
              type:
                typeof arguments_[0] === 'object' && arguments_[0] !== null
                  ? Reflect.get(arguments_[0], 'type')
                  : undefined,
            };
            try {
              const result = await original.apply(pc, arguments_);
              operations.push({ ...details, after: pc.signalingState });
              return result;
            } catch (error) {
              operations.push({
                ...details,
                error: error instanceof Error ? error.message : String(error),
                after: pc.signalingState,
              });
              throw error;
            }
          });
        }
        return pc;
      },
    });
    const streams: MediaStream[] = [];
    Reflect.set(window, '__testStreams', streams);
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints);
      streams.push(stream);
      return stream;
    };
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continuar' })).toBeEnabled();
  await page.getByLabel('Nome de exibição').fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(
    page.getByRole('heading', { name: 'Servidores públicos' }),
  ).toBeVisible();
  await expect(page.locator('.connection-bar')).toContainText('Conectado');
  return { context, page };
}
async function createRoom(page: Page, name: string) {
  await page.getByRole('button', { name: '+ Criar servidor' }).click();
  await page.getByLabel('Nome do servidor').fill(name);
  await page.getByRole('button', { name: 'Criar', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function enter(page: Page, name: string) {
  await page
    .locator('.server-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .getByRole('button', { name: 'Entrar', exact: true })
    .click();
  await expect(
    page.getByRole('log', { name: 'Histórico de mensagens' }),
  ).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByLabel('Mensagem', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
}
async function mediaStats(page: Page) {
  return page.evaluate(async () => {
    const peers = Reflect.get(window, '__testPeers') as RTCPeerConnection[];
    let packets = 0;
    let energy = 0;
    let audiblePeers = 0;
    for (const peer of peers) {
      const stats = await peer.getStats();
      stats.forEach((raw: unknown) => {
        const report = raw as RTCInboundRtpStreamStats;
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          packets += report.packetsReceived ?? 0;
          energy += report.totalAudioEnergy ?? 0;
          if ((report.totalAudioEnergy ?? 0) > 0) audiblePeers += 1;
        }
      });
    }
    const streams = Reflect.get(window, '__testStreams') as MediaStream[];
    return {
      packets,
      energy,
      audiblePeers,
      enabled: peers
        .flatMap((peer) => peer.getSenders())
        .filter((sender) => sender.track?.kind === 'audio')
        .map((sender) => sender.track?.enabled),
      open: peers.filter((peer) => peer.connectionState !== 'closed').length,
      liveTracks: streams
        .flatMap((stream) => stream.getTracks())
        .filter((track) => track.readyState === 'live').length,
    };
  });
}

test('duas sessões trocam texto, reconectam e reproduzem histórico sem duplicar', async ({
  browser,
}) => {
  const a = await participant(browser, 'Ana');
  const b = await participant(browser, 'Bruno');
  try {
    const name = `Texto ${Date.now()}`;
    await createRoom(a.page, name);
    await enter(a.page, name);
    await enter(b.page, name);
    await send(a.page, 'Olá de Ana');
    await expect(b.page.getByRole('log')).toContainText('Olá de Ana');
    await send(b.page, '<script>sem execução</script>');
    await expect(a.page.getByRole('log')).toContainText(
      '<script>sem execução</script>',
    );
    await a.context.setOffline(true);
    await expect(a.page.locator('.connection-bar')).toContainText(
      'Reconectando',
    );
    await a.context.setOffline(false);
    await expect(a.page.locator('.connection-bar')).toContainText('Conectado');
    await expect(
      a.page.locator('.chat-message').filter({ hasText: 'Olá de Ana' }),
    ).toHaveCount(1);
    await expect(a.page.locator('.participant-list li')).toHaveCount(2);
    await a.page.getByRole('button', { name: 'Voltar à lista' }).click();
    await expect(
      a.page.getByRole('heading', { name: 'Servidores públicos' }),
    ).toBeVisible();
    await enter(a.page, name);
    await expect(a.page.getByRole('log')).toContainText('Olá de Ana');
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('cinco participantes e rejeição real do sexto no backend', async ({
  browser,
}) => {
  const people: { context: BrowserContext; page: Page }[] = [];
  try {
    for (let index = 0; index < 6; index++)
      people.push(await participant(browser, `Pessoa ${index}`));
    const owner = people[0];
    if (!owner) throw new Error('Participante não criado');
    const name = `Lotação ${Date.now()}`;
    await createRoom(owner.page, name);
    for (const person of people.slice(0, 5)) await enter(person.page, name);
    await expect(owner.page.locator('.participant-list li')).toHaveCount(5);
    const sixth = people[5];
    if (!sixth) throw new Error('Sexto participante não criado');
    const card = sixth.page
      .locator('.server-card')
      .filter({ has: sixth.page.getByRole('heading', { name, exact: true }) });
    await expect(card).toContainText('Lotado');
    await expect(card.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    const id = await sixth.page.evaluate(async (name) => {
      const response = await fetch('/api/servers');
      const servers: { id: string; name: string }[] = await response.json();
      return servers.find((s) => s.name === name)?.id;
    }, name);
    const code = await sixth.page.evaluate(
      async (serverId) =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(
            `${location.origin.replace('http', 'ws')}/api/ws`,
          );
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error('Sem resposta'));
          }, 10000);
          ws.onmessage = (event) => {
            const value = JSON.parse(String(event.data));
            if (value.type === 'welcome')
              ws.send(
                JSON.stringify({ v: 1, type: 'join', server_id: serverId }),
              );
            if (value.type === 'error') {
              clearTimeout(timer);
              ws.close();
              resolve(String(value.code));
            }
          };
        }),
      id,
    );
    expect(code).toBe('server_full');
    await Promise.all(
      people
        .slice(0, 5)
        .map((person) =>
          person.page.getByRole('button', { name: 'Entrar na voz' }).click(),
        ),
    );
    for (const person of people.slice(0, 5)) {
      await expect(
        person.page
          .locator('.voice-peers li')
          .filter({ hasText: '· Conectado' }),
      ).toHaveCount(4);
      await expect
        .poll(async () => (await mediaStats(person.page)).audiblePeers)
        .toBe(4);
    }
    await owner.page.getByRole('button', { name: 'Voltar à lista' }).click();
    const remaining = people[1];
    if (!remaining) throw new Error('Participante não encontrado');
    await expect(remaining.page.locator('.participant-list li')).toHaveCount(4);
  } catch (error) {
    const diagnostics = await Promise.all(
      people.slice(0, 5).map((person) =>
        person.page.evaluate(() => ({
          peers: (
            Reflect.get(window, '__testPeers') as RTCPeerConnection[]
          ).map((pc) => ({
            connection: pc.connectionState,
            ice: pc.iceConnectionState,
            signaling: pc.signalingState,
            local: pc.localDescription?.type,
            remote: pc.remoteDescription?.type,
          })),
          operations: Reflect.get(window, '__testRtcOperations'),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (element) => element.textContent,
          ),
        })),
      ),
    );
    await test.info().attach('mesh-diagnostics', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await Promise.all(people.map((person) => person.context.close()));
  }
});

test('uma nova aba assume a sessão sem duplicar vagas e encerra voz antiga', async ({
  browser,
}) => {
  const a = await participant(browser, 'Ana Abas');
  try {
    const name = `Abas ${Date.now()}`;
    await createRoom(a.page, name);
    await enter(a.page, name);
    await a.page.getByRole('button', { name: 'Entrar na voz' }).click();
    await expect(
      a.page.getByRole('button', { name: 'Mutar microfone', exact: true }),
    ).toBeEnabled();
    const other = await a.context.newPage();
    await other.goto('/');
    await expect(
      other.getByRole('button', { name: 'Continuar' }),
    ).toBeEnabled();
    await other.getByRole('button', { name: 'Continuar' }).click();
    await expect(a.page.locator('.connection-bar')).toContainText(
      'Sessão ativa em outra aba',
    );
    await expect(other.locator('.participant-list li')).toHaveCount(1);
    expect((await mediaStats(a.page)).liveTracks).toBe(0);
  } finally {
    await a.context.close();
  }
});

test('libera a vaga após desconexão e expiração da reserva', async ({
  browser,
}) => {
  const a = await participant(browser, 'Ana Presença');
  const b = await participant(browser, 'Bruno Presença');
  try {
    const name = `Presença ${Date.now()}`;
    await createRoom(a.page, name);
    await enter(a.page, name);
    await enter(b.page, name);
    await expect(a.page.locator('.participant-list li')).toHaveCount(2);
    await b.context.close();
    await expect(a.page.locator('.participant-list')).toContainText(
      'Reconectando…',
    );
    await expect(a.page.locator('.participant-list li')).toHaveCount(1, {
      timeout: 25000,
    });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('interface móvel permite compor sem transbordar a largura da tela', async ({
  browser,
}) => {
  const a = await participant(browser, 'Ana Mobile');
  try {
    await a.page.setViewportSize({ width: 390, height: 844 });
    const name = `Móvel ${Date.now()}`;
    await createRoom(a.page, name);
    await enter(a.page, name);
    await send(a.page, 'Mensagem pelo celular');
    await expect(a.page.getByRole('log')).toContainText(
      'Mensagem pelo celular',
    );
    expect(
      await a.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await a.page.screenshot({
      path: test.info().outputPath('mobile-room.png'),
      fullPage: true,
    });
  } finally {
    await a.context.close();
  }
});

test('voz negocia entre dois contextos, recebe áudio, aplica mute e libera mídia', async ({
  browser,
}) => {
  const a = await participant(browser, 'Ana Voz');
  const b = await participant(browser, 'Bruno Voz');
  try {
    const name = `Voz ${Date.now()}`;
    await createRoom(a.page, name);
    await enter(a.page, name);
    await enter(b.page, name);
    await Promise.all([
      a.page.getByRole('button', { name: 'Entrar na voz' }).click(),
      b.page.getByRole('button', { name: 'Entrar na voz' }).click(),
    ]);
    await expect(a.page.locator('.voice-peers')).toContainText(
      'Bruno Voz · Conectado',
    );
    await expect(b.page.locator('.voice-peers')).toContainText(
      'Ana Voz · Conectado',
    );
    for (const page of [a.page, b.page]) {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const audio = document.querySelector('audio');
            const stream = audio?.srcObject;
            return (
              stream instanceof MediaStream &&
              stream
                .getAudioTracks()
                .some((track) => track.readyState === 'live') &&
              !!audio &&
              audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              audio.currentTime > 0
            );
          }),
        )
        .toBe(true);
      await expect
        .poll(async () => (await mediaStats(page)).energy)
        .toBeGreaterThan(0);
    }
    await a.page
      .getByRole('button', { name: 'Mutar microfone', exact: true })
      .click();
    expect((await mediaStats(a.page)).enabled).toEqual([false]);
    await expect(b.page.locator('.participant-list')).toContainText(
      'Na voz · Microfone mutado',
    );
    await expect
      .poll(async () => {
        const before = await mediaStats(b.page);
        await new Promise((resolve) => setTimeout(resolve, 600));
        return (await mediaStats(b.page)).energy - before.energy;
      })
      .toBe(0);
    await a.page
      .getByRole('button', { name: 'Desmutar microfone', exact: true })
      .click();
    expect((await mediaStats(a.page)).enabled).toEqual([true]);
    const mutedEnergy = (await mediaStats(b.page)).energy;
    await expect
      .poll(async () => (await mediaStats(b.page)).energy)
      .toBeGreaterThan(mutedEnergy);
    await a.page
      .getByRole('button', { name: 'Sair da voz', exact: true })
      .click();
    await expect(
      a.page.getByRole('button', { name: 'Entrar na voz' }),
    ).toBeVisible();
    await expect(a.page.locator('audio')).toHaveCount(0);
    await expect(b.page.locator('audio')).toHaveCount(0);
    expect((await mediaStats(a.page)).open).toBe(0);
    expect((await mediaStats(a.page)).liveTracks).toBe(0);
    await send(a.page, 'Continuo no texto');
    await expect(b.page.getByRole('log')).toContainText('Continuo no texto');
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('servidores, sessão e mensagens sobrevivem ao reinício real do processo Rust', async ({
  browser,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'conversa-persistence-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string')
    throw new Error('Porta indisponível');
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${address.port}`;
  const start = async () => {
    const child = spawn(join(process.cwd(), 'target/debug/discord-backend'), {
      stdio: 'ignore',
      env: {
        ...process.env,
        BACKEND_ADDR: `127.0.0.1:${address.port}`,
        DATABASE_URL: `sqlite://${join(directory, 'persist.db')}`,
        CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
        COOKIE_SECURE: 'false',
        STUN_URLS: '',
        TURN_URLS: '',
        TURN_SHARED_SECRET: '',
        RUST_LOG: 'warn',
      },
    });
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${base}/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    return child;
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  let child = await start();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:5173/');
    const roomId = await page.evaluate(async (base) => {
      const call = async (path: string, body: unknown) => {
        const response = await fetch(`${base}/api${path}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      };
      await call('/session', { display_name: 'Persistência' });
      const server: { id: string } = await call('/servers', {
        name: 'Servidor persistente',
      });
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${base.replace('http', 'ws')}/api/ws`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error('Timeout de persistência'));
        }, 10000);
        socket.onmessage = (event) => {
          const value = JSON.parse(String(event.data));
          if (value.type === 'welcome')
            socket.send(
              JSON.stringify({ v: 1, type: 'join', server_id: server.id }),
            );
          if (value.type === 'joined')
            socket.send(
              JSON.stringify({
                v: 1,
                type: 'message',
                client_id: crypto.randomUUID(),
                content: 'Mensagem após reinício',
              }),
            );
          if (value.type === 'ack') {
            clearTimeout(timer);
            socket.close();
            resolve();
          }
          if (value.type === 'error') {
            clearTimeout(timer);
            socket.close();
            reject(new Error(String(value.code)));
          }
        };
      });
      return server.id;
    }, base);
    await stop(child);
    child = await start();
    const messages = await page.evaluate(
      async ({ base, roomId }) => {
        const response = await fetch(`${base}/api/session`, {
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Sessão não persistiu');
        const socket = new WebSocket(`${base.replace('http', 'ws')}/api/ws`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Timeout de reconexão')),
            10000,
          );
          socket.onmessage = (event) => {
            const value = JSON.parse(String(event.data));
            if (value.type === 'welcome')
              socket.send(
                JSON.stringify({ v: 1, type: 'join', server_id: roomId }),
              );
            if (value.type === 'joined') {
              clearTimeout(timer);
              resolve();
            }
          };
        });
        const history = await fetch(`${base}/api/servers/${roomId}/messages`, {
          credentials: 'include',
        });
        const result: { messages: { content: string }[] } =
          await history.json();
        socket.close();
        return result.messages;
      },
      { base, roomId },
    );
    expect(messages.map((message) => message.content)).toEqual([
      'Mensagem após reinício',
    ]);
  } finally {
    await context.close();
    await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
