/**
 * SearchPage — unified offline discovery surface.
 *
 * Combines two prior pages (SearchPage + ArchivesHomePage) into one
 * Google-style destination: a prominent search bar on top, then the
 * installed archives laid out as category-grouped tiles (matching the
 * admin panel's visual language — minus the toggle, plus a click-to-
 * browse affordance). Typing a query hides the tiles and reveals
 * results; clearing the query brings the tiles back.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, AlertTriangle, X } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const API = '/api/v1/archives';

// ── Types ──────────────────────────────────────────────────────

interface SearchResult {
  source_id: string;
  title: string;
  path: string;
  snippet: string;
  url: string;
  source_label: string;
}

interface ArchiveStatus {
  source_id: string;
  label: string;
  description: string;
  category: string;
  favicon_path: string | null;
  config: { enabled: boolean } | null;
  state: { download_complete: boolean } | null;
}

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Category display order + header tint — mirrors ArchivesSection.tsx.
const CATEGORY_ORDER = [
  'Knowledge', 'Maintenance', 'Medical', 'Survival',
  'Education', 'Navigation', 'Reference', 'Inspiration',
];

const CATEGORY_BG: Record<string, string> = {
  Knowledge:   'bg-blue-500/15 dark:bg-blue-400/15',
  Maintenance: 'bg-sky-500/15 dark:bg-sky-400/15',
  Medical:     'bg-rose-500/15 dark:bg-rose-400/15',
  Survival:    'bg-amber-500/15 dark:bg-amber-400/15',
  Education:   'bg-violet-500/15 dark:bg-violet-400/15',
  Reference:   'bg-slate-500/15 dark:bg-slate-400/15',
  Inspiration: 'bg-emerald-500/15 dark:bg-emerald-400/15',
  Navigation:  'bg-teal-500/15 dark:bg-teal-400/15',
};

const categoryBg = (c: string) => CATEGORY_BG[c] ?? 'bg-primary/10';

// ── Component ──────────────────────────────────────────────────

const SearchPage: React.FC = () => {
  useDocumentTitle('Search');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sourceFilter = searchParams.get('source');

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState('');
  const [enabledSources, setEnabledSources] = useState<ArchiveStatus[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load enabled archives (treat downloaded + no-config as enabled).
  useEffect(() => {
    fetch(`${API}/status`, { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        const all: ArchiveStatus[] = data.archives || [];
        setEnabledSources(
          all.filter(a =>
            a.state?.download_complete
            && (a.config?.enabled ?? true),
          ),
        );
      })
      .catch(() => setEnabledSources([]))
      .finally(() => setLoadingSources(false));
  }, []);

  useEffect(() => {
    if (!loadingSources && enabledSources.length > 0) inputRef.current?.focus();
  }, [loadingSources, enabledSources.length]);

  const hasArchives = enabledSources.length > 0;

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim() || !hasArchives) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams({ q: q.trim(), limit: '15' });
      if (sourceFilter) params.set('sources', sourceFilter);
      const res = await fetch(`${API}/search?${params}`);
      const data = await res.json();
      setResults(data.results || []);
      setMessage(data.message || '');
    } catch {
      setResults([]);
      setMessage('Search failed — is the backend running?');
    } finally {
      setLoading(false);
    }
  }, [hasArchives, sourceFilter]);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    doSearch(query);
  };

  /** Open the rich per-archive landing (branded hero, search, random). */
  const openArchive = (sourceId: string) => {
    navigate(`/archive/${sourceId}`);
  };

  // Bucket archives by category for the tile grid.
  const grouped = useMemo(() => {
    const buckets: Record<string, ArchiveStatus[]> = {};
    for (const a of enabledSources) {
      (buckets[a.category] ||= []).push(a);
    }
    return CATEGORY_ORDER
      .map(cat => ({ category: cat, entries: buckets[cat] || [] }))
      .filter(g => g.entries.length > 0);
  }, [enabledSources]);

  const activeFilter = sourceFilter
    ? enabledSources.find(s => s.source_id === sourceFilter)
    : null;
  const showingResults = query.trim().length > 0 && searched;

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main className="flex-1 flex flex-col bg-background overflow-y-auto">
        {/* Header */}
        <header className="border-b border-border/10 px-[var(--app-shell-gutter)] pt-10 pb-8 sm:pt-12">
          <div className="mx-auto flex max-w-[var(--app-content-max)] items-center gap-4">
            <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary">
              <Search size={28} />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">
                {activeFilter ? `Search ${activeFilter.label}` : 'Knowledge Search'}
              </h1>
              <p className="text-base font-medium text-muted-foreground">
                {loadingSources
                  ? 'Loading…'
                  : hasArchives
                    ? activeFilter
                      ? 'Scoped to one archive'
                      : `${enabledSources.length} archive${enabledSources.length !== 1 ? 's' : ''} ready`
                    : 'No archives enabled'}
              </p>
            </div>
          </div>
        </header>

        <div className="flex-1 px-[var(--app-shell-gutter)] py-6">
          <div className="mx-auto max-w-[var(--app-content-max)] space-y-8">

            {/* Empty state — deliberately NO call-to-action button. The
                Knowledge Archives admin section is adminOnly, so a
                button here would dead-end non-admins with a permission
                screen. Text-only explanation is honest. */}
            {!loadingSources && !hasArchives && (
              <div className="rounded-xl border border-border/50 bg-card/50 p-8 text-center space-y-4">
                <div className="mx-auto w-12 h-12 rounded-2xl bg-muted flex items-center justify-center">
                  <AlertTriangle size={24} className="text-muted-foreground" />
                </div>
                <div>
                  <div className="text-sm font-medium">No archives enabled</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    An administrator needs to enable and download offline
                    archives before you can search them.
                  </div>
                </div>
              </div>
            )}

            {/* Search bar */}
            {hasArchives && (
              <>
                <form onSubmit={handleSubmit}>
                  <div className="relative">
                    <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={inputRef}
                      type="text"
                      value={query}
                      onChange={e => handleInput(e.target.value)}
                      placeholder={activeFilter
                        ? `Search ${activeFilter.label}…`
                        : 'Search your offline archives…'}
                      className="w-full rounded-xl border border-border bg-card/50 py-4 pl-12 pr-4 text-base placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                    />
                  </div>
                </form>

                {activeFilter && (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs text-primary">
                      <img
                        src={`${API}/favicon/${activeFilter.source_id}`}
                        alt=""
                        className="w-3.5 h-3.5 rounded"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      Scoped to {activeFilter.label}
                      <button
                        onClick={() => {
                          const next = new URLSearchParams(searchParams);
                          next.delete('source');
                          setSearchParams(next);
                        }}
                        className="ml-1 opacity-60 hover:opacity-100"
                        aria-label="Clear filter"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                )}
              </>
            )}

            {/* Results view — only when user has typed something */}
            {showingResults && (
              <div className="space-y-2">
                {loading && (
                  <div className="text-sm text-muted-foreground">Searching…</div>
                )}
                {!loading && results.length === 0 && (
                  <div className="rounded-xl border border-border/50 bg-card/50 p-6 text-center space-y-2">
                    <div className="text-sm text-muted-foreground">
                      {message || `No results for "${query}"`}
                    </div>
                    <div className="text-xs text-muted-foreground/60">
                      Try different keywords or enable more archives.
                    </div>
                  </div>
                )}
                {results.map((r, i) => (
                  <Link
                    key={`${r.source_id}-${r.path}-${i}`}
                    to={`/browse/${r.source_id}/${r.path}`}
                    className="block rounded-xl border border-border/50 bg-card/50 p-4 space-y-2 hover:border-primary/30 hover:bg-card/80 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <img
                        src={`${API}/favicon/${r.source_id}`}
                        alt=""
                        className="w-5 h-5 rounded mt-0.5 shrink-0"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground leading-snug">
                          {r.title}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {r.source_label}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground leading-relaxed line-clamp-3 pl-8">
                      {r.snippet}
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {/* Archive tiles — shown when no active search */}
            {hasArchives && !showingResults && (
              <div className="space-y-8">
                {grouped.map(({ category, entries }) => (
                  <section key={category} className="space-y-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                        {category}
                      </h3>
                      <span className="text-[10px] text-muted-foreground/60">{entries.length}</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
                      {entries.map(a => (
                        <button
                          key={a.source_id}
                          type="button"
                          onClick={() => openArchive(a.source_id)}
                          className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/30 bg-card shadow-sm hover:border-primary/40 hover:shadow-md transition-all cursor-pointer text-left"
                        >
                          <div className={`relative flex h-32 items-center justify-center ${categoryBg(a.category)}`}>
                            <img
                              src={`${API}/favicon/${a.source_id}`}
                              alt=""
                              className="h-16 w-16 object-contain"
                              onError={e => {
                                const el = e.target as HTMLImageElement;
                                el.style.display = 'none';
                                el.parentElement!.innerHTML += `<span class="text-4xl font-black text-foreground/50">${a.label[0]}</span>`;
                              }}
                            />
                          </div>
                          <div className="flex flex-1 flex-col gap-1.5 p-4">
                            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                              {a.category}
                            </span>
                            <h4 className="text-base font-bold tracking-tight leading-tight">
                              {a.label}
                            </h4>
                            <p className="text-xs text-muted-foreground leading-snug line-clamp-3">
                              {a.description}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default SearchPage;
