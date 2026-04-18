/**
 * ArchiveHomePage — branded landing for a single offline archive.
 *
 * Replaces the "plop user onto the raw ZIM mainEntry" UX (which for
 * Wikipedia shipped a near-empty "User:The other Kiwix guy/Landing"
 * page). This page gives every archive a Wikipedia-portal-style home:
 *
 *   - Hero row with favicon + archive name + category + article count
 *   - Big scoped search input (debounced type-ahead)
 *   - Quick-action cards: Random article, Open original main page,
 *     Continue where you left off
 *   - Recently viewed articles from localStorage
 *
 * The backend endpoints this page consumes:
 *   - GET /archives/:id/meta   — hero metadata
 *   - GET /archives/:id/main   — original ZIM main entry
 *   - GET /archives/:id/random — random article (surprise-me)
 *   - GET /archives/search?q&sources=id — scoped search
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Search, Shuffle, BookOpen, Clock, Home, ArrowRight, Loader2,
} from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const API = '/api/v1/archives';

// ── Types ──────────────────────────────────────────────────────

interface Meta {
  source_id: string;
  label: string;
  category: string;
  description: string;
  zim_title: string;
  zim_description: string;
  zim_language: string;
  zim_creator: string;
  article_count: number;
}

interface SearchResult {
  source_id: string;
  title: string;
  path: string;
  snippet: string;
  url: string;
  source_label: string;
}

interface RecentArticle {
  path: string;
  title: string;
  visited_at: number;
}

const CATEGORY_BG: Record<string, string> = {
  Knowledge:   'bg-blue-500/20',
  Maintenance: 'bg-sky-500/20',
  Medical:     'bg-rose-500/20',
  Survival:    'bg-amber-500/20',
  Education:   'bg-violet-500/20',
  Reference:   'bg-slate-500/20',
  Inspiration: 'bg-emerald-500/20',
  Navigation:  'bg-teal-500/20',
};

const categoryBg = (c: string) => CATEGORY_BG[c] ?? 'bg-primary/15';

/** localStorage key for per-archive recently-viewed articles. */
const recentKey = (sid: string) => `ld-archive-recent-${sid}`;

function loadRecent(sid: string): RecentArticle[] {
  try {
    const raw = localStorage.getItem(recentKey(sid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

// ── Component ──────────────────────────────────────────────────

const ArchiveHomePage: React.FC = () => {
  const { sourceId = '' } = useParams<{ sourceId: string }>();
  const navigate = useNavigate();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [randomLoading, setRandomLoading] = useState(false);
  const [recent, setRecent] = useState<RecentArticle[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useDocumentTitle(meta?.label ?? 'Archive');

  // Load archive metadata
  useEffect(() => {
    if (!sourceId) return;
    setLoading(true);
    fetch(`${API}/${sourceId}/meta`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((m: Meta) => setMeta(m))
      .catch(() => setMeta(null))
      .finally(() => setLoading(false));
    setRecent(loadRecent(sourceId));
  }, [sourceId]);

  // Debounced scoped search
  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) { setResults([]); return; }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: trimmed, sources: sourceId, limit: '8' });
      const res = await fetch(`${API}/search?${params}`);
      const data = await res.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [sourceId]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(() => runSearch(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  // Quick actions
  const openRandom = async () => {
    setRandomLoading(true);
    try {
      const res = await fetch(`${API}/${sourceId}/random`);
      if (res.ok) {
        const data = await res.json();
        if (data.path) navigate(`/browse/${sourceId}/${data.path}`);
      }
    } finally {
      setRandomLoading(false);
    }
  };

  const openMainEntry = async () => {
    const res = await fetch(`${API}/${sourceId}/main`);
    if (res.ok) {
      const data = await res.json();
      if (data.path) navigate(`/browse/${sourceId}/${data.path}`);
    }
  };

  const heroBg = categoryBg(meta?.category ?? '');
  const articleCountDisplay = useMemo(() => {
    const n = meta?.article_count ?? 0;
    if (n <= 0) return '';
    return `${n.toLocaleString()} articles`;
  }, [meta?.article_count]);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main className="flex-1 flex flex-col bg-background overflow-y-auto">
        {/* Branded hero */}
        <header className={`border-b border-border/10 ${heroBg}`}>
          <div className="px-[var(--app-shell-gutter)] pt-10 pb-10">
            <div className="mx-auto max-w-[var(--app-content-max)] flex items-start gap-5">
              <div className="w-20 h-20 rounded-2xl bg-card/80 border border-border/30 flex items-center justify-center overflow-hidden shrink-0">
                <img
                  src={`${API}/favicon/${sourceId}`}
                  alt=""
                  className="w-14 h-14 object-contain"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3 mb-1">
                  {meta?.category && (
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      {meta.category}
                    </span>
                  )}
                  {articleCountDisplay && (
                    <span className="text-[10px] text-muted-foreground/60 font-medium">
                      {articleCountDisplay}
                    </span>
                  )}
                  <Link
                    to="/search"
                    className="text-[10px] text-muted-foreground/60 hover:text-foreground flex items-center gap-0.5"
                  >
                    <Home size={10} /> All archives
                  </Link>
                </div>
                <h1 className="text-4xl font-black tracking-tight mb-1">
                  {loading ? '…' : (meta?.label ?? sourceId)}
                </h1>
                <p className="text-base text-muted-foreground max-w-2xl leading-snug">
                  {meta?.description || meta?.zim_description}
                </p>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 px-[var(--app-shell-gutter)] py-8">
          <div className="mx-auto max-w-[var(--app-content-max)] space-y-8">
            {/* Search */}
            <div className="relative">
              {searching
                ? <Loader2 size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />
                : <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />}
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={`Search ${meta?.label ?? 'this archive'}…`}
                className="w-full rounded-xl border border-border bg-card/50 py-4 pl-12 pr-4 text-base placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>

            {/* Inline search results */}
            {query.trim() && (
              <div className="space-y-2">
                {!searching && results.length === 0 && (
                  <div className="text-sm text-muted-foreground px-2">
                    No results for "{query}"
                  </div>
                )}
                {results.map((r, i) => (
                  <Link
                    key={`${r.path}-${i}`}
                    to={`/browse/${sourceId}/${r.path}`}
                    className="block rounded-xl border border-border/50 bg-card/50 p-4 space-y-1 hover:border-primary/30 hover:bg-card/80 transition-colors"
                  >
                    <div className="text-sm font-semibold text-foreground leading-snug">
                      {r.title}
                    </div>
                    <div className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                      {r.snippet}
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {/* Quick-action cards — shown only when not actively searching */}
            {!query.trim() && (
              <>
                <section className="space-y-3">
                  <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Explore
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      onClick={openRandom}
                      disabled={randomLoading}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-border/30 bg-card/40 hover:bg-card/80 hover:border-primary/40 p-5 text-left transition-colors"
                    >
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          {randomLoading
                            ? <Loader2 size={16} className="text-primary animate-spin" />
                            : <Shuffle size={16} className="text-primary" />}
                          <span className="text-sm font-bold">Random article</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Surprise me with something from this archive.
                        </p>
                      </div>
                      <ArrowRight size={16} className="text-muted-foreground shrink-0" />
                    </button>
                    <button
                      onClick={openMainEntry}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-border/30 bg-card/40 hover:bg-card/80 hover:border-primary/40 p-5 text-left transition-colors"
                    >
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <BookOpen size={16} className="text-primary" />
                          <span className="text-sm font-bold">Original main page</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Open the ZIM's built-in entry point.
                        </p>
                      </div>
                      <ArrowRight size={16} className="text-muted-foreground shrink-0" />
                    </button>
                  </div>
                </section>

                {/* Recently viewed */}
                {recent.length > 0 && (
                  <section className="space-y-3">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground flex items-center gap-2">
                      <Clock size={11} /> Recently viewed
                    </h3>
                    <ul className="divide-y divide-border/30 rounded-xl border border-border/30 bg-card/40 overflow-hidden">
                      {recent.map(r => (
                        <li key={r.path}>
                          <Link
                            to={`/browse/${sourceId}/${r.path}`}
                            className="flex items-center gap-3 px-4 py-3 hover:bg-card transition-colors text-sm"
                          >
                            <BookOpen size={14} className="text-muted-foreground shrink-0" />
                            <span className="truncate font-medium">{r.title}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default ArchiveHomePage;
