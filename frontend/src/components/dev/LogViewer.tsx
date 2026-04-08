import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, Trash2, Filter, Copy, Check } from 'lucide-react';

type LogRecord = {
  id: number;
  ts: number;
  level: string;
  logger: string;
  message: string;
};

const LEVEL_COLOR: Record<string, string> = {
  DEBUG: 'text-muted-foreground',
  INFO: 'text-foreground',
  WARNING: 'text-amber-400',
  ERROR: 'text-red-400',
  CRITICAL: 'text-red-500 font-bold',
};

const LogViewer: React.FC<{ height?: string }> = ({ height = 'h-96' }) => {
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Brief checkmark after a successful copy. Auto-clears so the
  // copy button reverts to its idle icon without needing user input.
  const [justCopied, setJustCopied] = useState(false);

  useEffect(() => {
    // EventSource auto-reconnects on transient failures. credentials
    // default to same-origin which carries our session cookie.
    const es = new EventSource('/api/v1/logs/stream');
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const rec = JSON.parse(ev.data) as LogRecord;
        setRecords((prev) => {
          const next = [...prev, rec];
          return next.length > 2000 ? next.slice(-2000) : next;
        });
        setError(null);
      } catch {
        // ignore malformed frame
      }
    };
    es.onerror = () => {
      setError('stream disconnected — retrying…');
    };
    return () => {
      es.close();
    };
  }, []);

  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [records, paused]);

  const filtered = filter
    ? records.filter(
        (r) =>
          r.message.toLowerCase().includes(filter.toLowerCase()) ||
          r.logger.toLowerCase().includes(filter.toLowerCase()) ||
          r.level.toLowerCase().includes(filter.toLowerCase()),
      )
    : records;

  // Copy whatever the user is currently *seeing* — i.e. the filtered
  // view, not the full record buffer. Matches the mental model: "I
  // filtered to errors, I want the errors." Falls back to the legacy
  // execCommand path for non-secure-context dev servers where
  // navigator.clipboard is undefined.
  const handleCopy = async () => {
    const text = filtered
      .map((r) => `${new Date(r.ts * 1000).toISOString()} ${r.level} ${r.logger}: ${r.message}`)
      .join('\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setJustCopied(true);
      window.setTimeout(() => setJustCopied(false), 1500);
    } catch {
      // Swallow — clipboard failures are non-fatal and the user will
      // notice the missing checkmark.
    }
  };

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 shadow-m1 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/20 bg-background/40">
        <Filter className="w-3.5 h-3.5 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter (level, logger, text)…"
          className="flex-1 bg-transparent border-none outline-none text-xs font-mono placeholder-muted-foreground/50"
        />
        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
          {filtered.length}/{records.length}
        </span>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="p-1 rounded hover:bg-card/80 text-muted-foreground hover:text-foreground"
          title={paused ? 'Resume' : 'Pause'}
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          disabled={filtered.length === 0}
          className="p-1 rounded hover:bg-card/80 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          title={`Copy ${filtered.length} log line${filtered.length === 1 ? '' : 's'}`}
        >
          {justCopied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
        </button>
        <button
          type="button"
          onClick={() => setRecords([])}
          className="p-1 rounded hover:bg-card/80 text-muted-foreground hover:text-red-400"
          title="Clear"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {error && (
        <div className="px-4 py-2 text-[11px] text-red-400 border-b border-red-400/20 bg-red-400/5">
          {error}
        </div>
      )}
      <div
        ref={scrollRef}
        className={`${height} overflow-y-auto font-mono text-[11px] leading-relaxed bg-background/20`}
      >
        {filtered.length === 0 ? (
          <div className="p-4 text-muted-foreground italic text-xs">No log records yet.</div>
        ) : (
          filtered.map((r) => (
            <div
              key={r.id}
              className="px-4 py-0.5 hover:bg-card/40 border-b border-border/5 whitespace-pre-wrap break-all"
            >
              <span className={LEVEL_COLOR[r.level] || 'text-foreground'}>{r.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LogViewer;
