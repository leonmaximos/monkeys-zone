import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  api,
  ApiError,
  errorMessage,
  normalizeName,
  validName,
} from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { realtime } from '@/lib/realtime';
import { AudioSetup } from '@/features/audio/AudioSetup';
import { readPreferences, savePreferences } from '@/features/audio/devices';
import { ServerList } from '@/features/servers/ServerList';
import { ServerRoom } from '@/features/room/ServerRoom';

export function App() {
  const session = useAppStore((s) => s.session);
  const room = useAppStore((s) => s.room);
  const connection = useAppStore((s) => s.connection);
  const error = useAppStore((s) => s.error);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(() => readPreferences().displayName);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api
      .session()
      .then((session) => {
        if (cancelled) return;
        useAppStore.setState({ session });
        setName(session.display_name);
      })
      .catch((error: unknown) => {
        if (
          !cancelled &&
          (!(error instanceof ApiError) || error.status !== 401)
        )
          setFormError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    realtime.start();
    return () => realtime.stop();
  }, [ready]);
  const identify = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');
    if (!validName(name)) {
      setFormError(
        'O nome deve conter entre 2 e 32 caracteres após normalizar os espaços.',
      );
      return;
    }
    setSubmitting(true);
    try {
      const identified = session ?? (await api.identify(normalizeName(name)));
      savePreferences({
        ...readPreferences(),
        displayName: identified.display_name,
      });
      useAppStore.setState({ session: identified });
      setReady(true);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };
  if (!ready || !session)
    return (
      <main className="onboarding">
        <section className="intro-copy">
          <a className="brand" href="/">
            ◉ conversa
          </a>
          <p className="eyebrow">SEU GRUPO, MAIS PERTO</p>
          <h1>
            Uma conversa
            <br />
            começa com você.
          </h1>
          <p>
            Encontre seu grupo. Troque ideias por texto e entre na voz quando
            quiser.
          </p>
          <div className="intro-note">
            <span>Até 5 pessoas por sala</span>
            <span>Sem senha ou cadastro</span>
            <span>Texto e voz no seu navegador</span>
          </div>
        </section>
        <section className="setup-card" aria-label="Identificação e áudio">
          <h2>Como podemos chamar você?</h2>
          <p className="hint">
            Seu nome será visível aos outros participantes.
          </p>
          <form onSubmit={(event) => void identify(event)}>
            <label>
              Nome de exibição
              <input
                autoComplete="nickname"
                value={name}
                disabled={loading || !!session}
                maxLength={96}
                onChange={(event) => setName(event.target.value)}
                placeholder="Seu nome"
                required
                aria-describedby="name-help"
              />
            </label>
            <p id="name-help" className="hint">
              De 2 a 32 caracteres.{' '}
              {session &&
                'Sua identidade já está vinculada a esta sessão do navegador.'}
            </p>
            <AudioSetup />
            {formError && <p role="alert">{formError}</p>}
            <Button type="submit" disabled={loading || submitting}>
              {loading
                ? 'Verificando sessão…'
                : submitting
                  ? 'Identificando…'
                  : 'Continuar'}
            </Button>
            <p className="hint">
              Você pode continuar sem microfone e usar o chat de texto.
            </p>
          </form>
        </section>
      </main>
    );
  return (
    <div className="app-shell">
      <aside className="navigation">
        <a className="brand" href="/">
          ◉ conversa
        </a>
        <p className="eyebrow">SEU ESPAÇO</p>
        <button
          className="nav-item"
          onClick={() => {
            if (room) realtime.send({ type: 'leave' });
          }}
        >
          ▦ Servidores públicos
        </button>
        <div className="session-card">
          <span className="avatar">
            {session.display_name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{session.display_name}</strong>
            <p className="hint">Sessão anônima</p>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <div className="connection-bar">
          <span
            className={`connection-dot ${connection === 'online' ? 'online' : ''}`}
          />
          {
            {
              online: 'Conectado',
              connecting: 'Conectando…',
              reconnecting: 'Reconectando… A voz foi encerrada.',
              offline: 'Sem conexão',
              replaced: 'Sessão ativa em outra aba',
            }[connection]
          }
          {(connection === 'offline' || connection === 'replaced') && (
            <button onClick={() => realtime.restart()}>
              {connection === 'replaced' ? 'Assumir nesta aba' : 'Reconectar'}
            </button>
          )}
        </div>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button
              aria-label="Fechar aviso"
              onClick={() => useAppStore.setState({ error: '' })}
            >
              ×
            </button>
          </div>
        )}
        {room ? <ServerRoom session={session} /> : <ServerList />}
      </main>
    </div>
  );
}
