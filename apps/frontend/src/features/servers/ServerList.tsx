import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, errorMessage, validName, normalizeName } from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { realtime } from '@/lib/realtime';

export function ServerList() {
  const servers = useAppStore((s) => s.servers);
  const connection = useAppStore((s) => s.connection);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      useAppStore.setState({ servers: await api.servers() });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    void api
      .servers()
      .then((servers) => {
        if (active) useAppStore.setState({ servers });
      })
      .catch((error: unknown) => {
        if (active) setError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!validName(name, 64)) {
      setError('O nome do servidor deve conter entre 2 e 64 caracteres.');
      return;
    }
    setBusy(true);
    try {
      await api.createServer(normalizeName(name));
      setName('');
      setCreating(false);
      await realtime.refreshServers();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="server-directory">
      <header className="page-header">
        <div>
          <p className="eyebrow">CONVERSE EM BOA COMPANHIA</p>
          <h1>Servidores públicos</h1>
          <p className="hint">
            Escolha uma sala ou crie um espaço para o seu grupo.
          </p>
        </div>
        <Button onClick={() => setCreating(!creating)}>
          {creating ? 'Cancelar criação' : '+ Criar servidor'}
        </Button>
      </header>
      {creating && (
        <form
          className="create-server"
          onSubmit={(event) => void create(event)}
        >
          <label>
            Nome do servidor
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={128}
              placeholder="Ex.: Café da tarde"
              required
            />
          </label>
          <Button disabled={busy} type="submit">
            {busy ? 'Criando…' : 'Criar'}
          </Button>
        </form>
      )}
      {error && (
        <div role="alert">
          {error}
          <button onClick={() => void reload()}>Tentar novamente</button>
        </div>
      )}
      {loading && <p role="status">Carregando servidores…</p>}
      {!loading && !error && servers.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon">◌</span>
          <h2>A primeira conversa pode ser sua.</h2>
          <p>
            Ainda não há servidores. Crie um e convide seu grupo a abrir este
            site.
          </p>
        </div>
      )}
      <div className="server-grid">
        {servers.map((server) => (
          <article className="server-card" key={server.id}>
            <span className="server-icon">
              {server.name.slice(0, 1).toUpperCase()}
            </span>
            <h2>{server.name}</h2>
            <p className="hint">Uma sala de texto e voz</p>
            <div className="server-card-footer">
              <span>
                {server.participants}/5 participantes{' '}
                {server.participants >= 5 && <strong>· Lotado</strong>}
              </span>
              <Button
                disabled={connection !== 'online' || server.participants >= 5}
                onClick={() => {
                  if (!realtime.send({ type: 'join', server_id: server.id }))
                    useAppStore.setState({
                      error: 'Aguarde a conexão para entrar.',
                    });
                }}
              >
                Entrar
              </Button>
            </div>
          </article>
        ))}
      </div>
      <p className="directory-footnote">
        Todos os servidores são públicos. Você pode participar de um por vez.
      </p>
    </section>
  );
}
