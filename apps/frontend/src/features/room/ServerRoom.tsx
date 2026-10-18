import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/contracts';
import { useAppStore } from '@/lib/store';
import { realtime } from '@/lib/realtime';
import { AudioSetup } from '../audio/AudioSetup';
import { useVoice } from '../voice/useVoice';

export function ServerRoom({ session }: { session: Session }) {
  const room = useAppStore((s) => s.room);
  const servers = useAppStore((s) => s.servers);
  const messages = useAppStore((s) => s.messages);
  const pending = useAppStore((s) => s.pending);
  const notices = useAppStore((s) => s.notices);
  const nextBefore = useAppStore((s) => s.nextBefore);
  const connection = useAppStore((s) => s.connection);
  const [draft, setDraft] = useState('');
  const [settings, setSettings] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [composeError, setComposeError] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const voice = useVoice(session.id);
  const latestMessage = messages.at(-1)?.id;
  useEffect(() => {
    if (stickToBottom.current)
      list.current?.scrollTo?.({
        top: list.current.scrollHeight,
        behavior: 'smooth',
      });
  }, [latestMessage, pending.length]);
  if (!room) return null;
  const server = servers.find((s) => s.id === room.server_id);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || Array.from(draft.trim()).length > 2000) {
      setComposeError('Escreva uma mensagem com até 2.000 caracteres.');
      return;
    }
    realtime.sendMessage(draft.trim());
    setDraft('');
    setComposeError('');
    stickToBottom.current = true;
  };
  const loadOlder = async () => {
    if (!nextBefore || !list.current) return;
    const oldHeight = list.current.scrollHeight;
    const top = list.current.scrollTop;
    setLoadingOlder(true);
    await realtime.loadHistory(nextBefore);
    setLoadingOlder(false);
    requestAnimationFrame(() => {
      if (list.current)
        list.current.scrollTop = top + list.current.scrollHeight - oldHeight;
    });
  };
  return (
    <section className="room-layout">
      <header className="room-header">
        <div>
          <p className="eyebrow">SALA INTEGRADA</p>
          <h1>{server?.name ?? 'Servidor'}</h1>
          <span className="hint">
            {room.participants.length}/5 participantes
          </span>
        </div>
        <button
          className="secondary-button"
          onClick={() => {
            voice.leave();
            realtime.send({ type: 'leave' });
          }}
        >
          ← Voltar à lista
        </button>
      </header>
      <div className="conversation">
        <div
          className="chat-history"
          role="log"
          aria-label="Histórico de mensagens"
          ref={list}
          onScroll={() => {
            const element = list.current;
            if (element)
              stickToBottom.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                100;
          }}
        >
          {nextBefore && (
            <button
              className="load-history"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? 'Carregando…' : 'Carregar mensagens anteriores'}
            </button>
          )}
          <div className="chat-welcome">
            <span className="server-icon">#</span>
            <h2>Bem-vindo a {server?.name ?? 'esta sala'}</h2>
            <p className="hint">
              As mensagens ficam salvas. A voz só começa quando você decidir
              entrar.
            </p>
          </div>
          {messages.map((message) => (
            <article className="chat-message" key={message.id}>
              <span className="avatar">
                {message.sender_name.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <header>
                  <strong>{message.sender_name}</strong>
                  <time dateTime={new Date(message.created_at).toISOString()}>
                    {new Date(message.created_at).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </header>
                <p>{message.content}</p>
              </div>
            </article>
          ))}
          {pending
            .filter((p) => p.server_id === room.server_id)
            .map((message) => (
              <article className="pending-message" key={message.client_id}>
                <p>{message.content}</p>
                <small>
                  {message.state === 'sending'
                    ? 'Aguardando confirmação…'
                    : message.error}
                </small>
                {message.state === 'failed' && (
                  <button
                    disabled={connection !== 'online'}
                    onClick={() =>
                      realtime.sendMessage(message.content, message.client_id)
                    }
                  >
                    Reenviar
                  </button>
                )}
              </article>
            ))}
        </div>
        <div className="presence-notice" aria-live="polite">
          {notices.at(-1) ?? 'Você está no chat de texto.'}
        </div>
        <form className="message-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="message">
            Mensagem
          </label>
          <textarea
            id="message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={8000}
            rows={2}
            placeholder={`Conversar em ${server?.name ?? 'esta sala'}…`}
            disabled={connection !== 'online'}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div>
            <small>
              {Array.from(draft).length}/2000 · Shift+Enter para nova linha
            </small>
            <Button
              type="submit"
              disabled={
                connection !== 'online' ||
                !draft.trim() ||
                Array.from(draft.trim()).length > 2000
              }
            >
              Enviar
            </Button>
          </div>
          {composeError && <p role="alert">{composeError}</p>}
        </form>
      </div>
      <aside className="room-sidebar">
        <section>
          <h2>
            Participantes{' '}
            <span className="hint">{room.participants.length}/5</span>
          </h2>
          <ul className="participant-list">
            {room.participants.map((p) => (
              <li key={p.id}>
                <span className="avatar">
                  {p.display_name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>
                    {p.display_name}
                    {p.id === session.id && ' (você)'}
                  </strong>
                  <p className="hint">
                    {!p.connected
                      ? 'Reconectando…'
                      : p.in_voice
                        ? p.muted
                          ? 'Na voz · Microfone mutado'
                          : 'Na voz · Microfone ativo'
                        : 'No texto'}
                  </p>
                </div>
                <span
                  className={`connection-dot ${p.connected ? 'online' : ''}`}
                />
              </li>
            ))}
          </ul>
        </section>
        <section className="voice-panel">
          <p className="eyebrow">CHAT DE VOZ</p>
          <h2>
            {voice.status === 'active'
              ? 'Você está na voz'
              : voice.status === 'joining'
                ? 'Conectando à voz…'
                : 'A conversa também tem voz'}
          </h2>
          <p className="hint">
            {room.participants.filter((p) => p.in_voice).length} participante(s)
            na voz
          </p>
          <ul className="voice-peers">
            {room.participants
              .filter((p) => p.in_voice)
              .map((p) => (
                <li key={p.id}>
                  {p.display_name} ·{' '}
                  {p.muted
                    ? 'Mutado'
                    : p.id === session.id
                      ? 'Microfone ativo'
                      : {
                          connected: 'Conectado',
                          connecting: 'Conectando…',
                          new: 'Preparando…',
                          disconnected: 'Reconectando…',
                          failed: 'Falha na conexão',
                          closed: 'Encerrado',
                        }[voice.peers[p.id] ?? 'new']}
                </li>
              ))}
          </ul>
          {voice.status === 'off' ? (
            <Button
              disabled={connection !== 'online'}
              onClick={() => void voice.join()}
            >
              Entrar na voz
            </Button>
          ) : (
            <>
              <Button
                disabled={voice.status !== 'active'}
                onClick={voice.toggleMute}
              >
                {voice.muted ? 'Desmutar microfone' : 'Mutar microfone'}
              </Button>
              <button className="danger-button" onClick={voice.leave}>
                Sair da voz
              </button>
            </>
          )}
          {voice.error && <p role="alert">{voice.error}</p>}
          {voice.playbackBlocked && (
            <button
              className="secondary-button"
              onClick={() => void voice.resumePlayback()}
            >
              Ativar áudio recebido
            </button>
          )}
          <button
            className="settings-button"
            onClick={() => setSettings(!settings)}
          >
            {settings ? 'Fechar dispositivos' : 'Configurar dispositivos'}
          </button>
          {settings && (
            <>
              <p className="hint">
                Alterar o dispositivo encerra a voz. Entre novamente para
                aplicar.
              </p>
              <AudioSetup onChange={voice.changeDevices} />
            </>
          )}
        </section>
      </aside>
    </section>
  );
}
