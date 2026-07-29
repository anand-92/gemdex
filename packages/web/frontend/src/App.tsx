import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, type Session } from './api';
import { AmbientBackdrop } from './components/AmbientBackdrop';
import { GemdexMark } from './components/GemdexMark';
import { Sidebar } from './components/Sidebar';
import { PoolProvider } from './lib/pool';
import { CreateMemory } from './pages/CreateMemory';
import { IngestHistory } from './pages/IngestHistory';
import { MemoryPool } from './pages/MemoryPool';
import { StatusPage } from './pages/StatusPage';
import { UploadSessions } from './pages/UploadSessions';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    async function checkSession() {
      try {
        const s = await api.session();
        setSession(s);
      } catch {
        setFailed(true);
      }
    }
    checkSession();
  }, []);

  if (failed) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-canvas text-ink">
        <div className="surface flex max-w-sm flex-col items-center gap-4 rounded-card border border-danger/30 p-8 text-center shadow-card">
          <span className="flex h-10 w-10 items-center justify-center rounded-card bg-danger/10 text-danger">
            !
          </span>
          <p className="text-[13px] text-danger">Could not reach the Gemdex web server.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-card border border-edge bg-white/[0.04] px-4 py-2 text-[12px] text-ink transition-colors hover:bg-white/[0.08]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-canvas text-ink">
        <div className="flex flex-col items-center gap-3">
          <span className="flex h-10 w-10 animate-pulse items-center justify-center rounded-card border border-edge bg-white/[0.03] text-accent">
            <GemdexMark size={20} />
          </span>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            Loading session…
          </p>
        </div>
      </div>
    );
  }

  if (!session.authenticated) {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center bg-canvas text-ink overflow-hidden">
        <AmbientBackdrop />
        <div className="surface relative z-10 flex w-full max-w-sm flex-col items-center gap-6 rounded-panel border border-edge p-8 text-center shadow-lift">
          <span className="flex h-12 w-12 items-center justify-center rounded-card border border-edge-accent bg-accent/[0.14] text-accent shadow-glow">
            <GemdexMark size={24} />
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="display text-[22px] text-ink">Gemdex</h1>
            <p className="text-[13px] text-ink-muted">Sign in to manage your memory pool.</p>
          </div>
          <a
            href={session.loginUrl}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-card bg-accent text-[13.5px] font-semibold text-canvas shadow-glow transition-colors hover:bg-accent-hover"
          >
            Sign in with Google
          </a>
        </div>
      </div>
    );
  }

  return (
    <PoolProvider>
      <BrowserRouter>
        <div className="relative flex h-full min-h-full w-full overflow-hidden bg-canvas font-sans text-ink antialiased">
          <AmbientBackdrop />
          <div className="relative z-10 flex h-full w-full min-w-0">
            <Sidebar />
            <Routes>
              <Route path="/" element={<MemoryPool />} />
              <Route path="/new" element={<CreateMemory />} />
              <Route path="/upload" element={<UploadSessions />} />
              <Route path="/history" element={<IngestHistory />} />
              <Route path="/status" element={<StatusPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </BrowserRouter>
    </PoolProvider>
  );
}
