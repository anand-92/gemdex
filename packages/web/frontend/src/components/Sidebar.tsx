import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  DatabaseIcon,
  FileUpIcon,
  HeartPulseIcon,
  LogOutIcon,
  PlusIcon,
  ScrollTextIcon,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { api, type Session } from '../api';
import { formatCount } from '../lib/format';
import { usePool } from '../lib/pool';
import { GemdexMark } from './GemdexMark';

const NAV_ITEMS = [
  { to: '/', label: 'Memory pool', icon: DatabaseIcon },
  { to: '/upload', label: 'Upload sessions', icon: FileUpIcon },
  { to: '/history', label: 'History', icon: ScrollTextIcon },
  { to: '/status', label: 'Status', icon: HeartPulseIcon },
];

const SCANNER_COPY: Record<string, string> = {
  idle: 'Scanner idle',
  scanning: 'Scanning sessions',
  done: 'No new sessions',
};

const TREND = [12, 18, 15, 26, 22, 34, 30, 44, 41, 52, 63, 58, 74];

function PoolSparkline() {
  const max = Math.max(...TREND);
  const points = TREND.map((value, index) => {
    const x = (index / (TREND.length - 1)) * 100;
    const y = 24 - (value / max) * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      viewBox="0 0 100 26"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="h-6 w-full"
    >
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6c8cff" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#6c8cff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,26 ${points.join(' ')} 100,26`} fill="url(#spark)" />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="#6c8cff"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Sidebar() {
  const { poolTotal, scanner } = usePool();
  const location = useLocation();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const s = await api.session();
        setSession(s);
      } catch {
        // Handled in main shell if 401/down
      }
    }
    load();
  }, []);

  const logout = async () => {
    try {
      await api.logout();
      window.location.reload();
    } catch (err) {
      console.error('Failed to logout:', err);
    }
  };

  return (
    <nav
      aria-label="Primary"
      className="glass flex h-full w-[248px] shrink-0 flex-col border-r border-edge"
    >
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-edge px-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-edge-accent bg-accent/[0.14] text-accent shadow-glow-sm"
        >
          <GemdexMark size={16} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="display text-[15px] leading-none text-ink">Gemdex</span>
          <span className="font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
            memory layer
          </span>
        </span>
        {session?.authMode === 'dev' ? (
          <span
            title="GEMDEX_WEB_AUTH=dev — no login required"
            className="ml-auto shrink-0 rounded-pill border border-edge-warn bg-warn/[0.08] px-2 py-[3px] font-mono text-[9.5px] uppercase leading-none tracking-[0.1em] text-warn"
          >
            dev
          </span>
        ) : session?.email ? (
          <span
            title={session.email}
            className="ml-auto shrink-0 max-w-[80px] truncate rounded-pill border border-edge-accent bg-accent/[0.08] px-2 py-[3px] font-mono text-[9.5px] text-accent"
          >
            {session.email.split('@')[0]}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
        <NavLink
          to="/new"
          className="flex h-9 items-center justify-center gap-2 rounded-card bg-accent text-[13px] font-semibold leading-none text-canvas shadow-glow transition-colors hover:bg-accent-hover"
        >
          <PlusIcon size={14} aria-hidden="true" strokeWidth={2.5} />
          New memory
        </NavLink>

        <div className="flex flex-col gap-1">
          <span className="px-3 pb-1 font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
            Workspace
          </span>
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
            const isActive =
              to === '/' ? location.pathname === '/' : location.pathname === to;
            return (
              <NavLink
                key={to}
                to={to}
                className="relative flex h-9 items-center rounded-card px-3"
              >
                {isActive && (
                  <motion.span
                    layoutId="nav-active"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    className="surface absolute inset-0 rounded-card border border-edge shadow-card"
                  />
                )}
                <span
                  className={[
                    'relative z-10 flex min-w-0 items-center gap-2.5 text-[13px] leading-none transition-colors',
                    isActive ? 'text-ink' : 'text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  <Icon
                    size={15}
                    aria-hidden="true"
                    className={isActive ? 'text-accent' : 'text-ink-faint'}
                  />
                  {label}
                </span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="relative z-10 ml-auto h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm"
                  />
                )}
              </NavLink>
            );
          })}
        </div>

        <div className="surface flex flex-col gap-2 rounded-card border border-edge px-3 py-3 shadow-card">
          <span className="font-mono text-[9.5px] uppercase leading-none tracking-[0.16em] text-ink-faint">
            Pool size
          </span>
          <div className="flex items-baseline gap-2">
            <motion.span
              key={poolTotal}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="tabular display text-[26px] leading-none text-ink"
            >
              {formatCount(poolTotal)}
            </motion.span>
          </div>
          <PoolSparkline />
          <span className="text-[11px] leading-none text-ink-muted">
            memories embedded
          </span>
        </div>
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-edge px-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center">
            <span
              aria-hidden="true"
              className={[
                'absolute inset-0 rounded-full',
                scanner === 'scanning' ? 'animate-pulse-ring bg-accent' : 'bg-ok',
              ].join(' ')}
            />
            <span
              aria-hidden="true"
              className={[
                'relative h-1.5 w-1.5 rounded-full',
                scanner === 'scanning' ? 'bg-accent' : 'bg-ok',
              ].join(' ')}
            />
          </span>
          <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
            {SCANNER_COPY[scanner]}
          </span>
        </span>
        {session?.authMode === 'google' && (
          <button
            type="button"
            onClick={logout}
            aria-label="Sign out"
            title={session.email ? `Sign out (${session.email})` : 'Sign out'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-transparent text-ink-faint transition-colors hover:border-edge hover:bg-white/[0.04] hover:text-ink-muted"
          >
            <LogOutIcon size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </nav>
  );
}
