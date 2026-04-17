/**
 * SearchPage — offline search engine across installed ZIM archives.
 *
 * Lives inside the app shell (sidebar visible). Shows available
 * sources, blocks search when none are enabled, and renders results
 * with favicons and links to the article browser.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, BookOpen, AlertTriangle } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const API = '/api/v1/archives';

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
  category: string;
  favicon_path: string | null;
  config: { enabled: boolean } | null;
  state: { download_complete: boolean } | null;
}

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const SearchPage: React.FC = () => {
  useDocumentTitle('Search');

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState('');
  const [enabledSources, setEnabledSources] = useState<ArchiveStatus[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load enabled archive sources
  useEffect(() => {
    fetch(`${API}/status`, { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        const archives: ArchiveStatus[] = data.archives || [];
        setEnabledSources(archives.filter(a => a.config?.enabled && a.state?.download_complete));
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
      const res = await fetch(`${API}/search?q=${encodeURIComponent(q.trim())}&limit=10`);
      const data = await res.json();
      setResults(data.results || []);
      setMessage(data.message || '');
    } catch {
      setResults([]);
      setMessage('Search failed — is the backend running?');
    } finally {
      setLoading(false);
    }
  }, [hasArchives]);

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
              <h1 className="text-3xl font-bold tracking-tight">Knowledge Search</h1>
              <p className="text-base font-medium text-muted-foreground">
                {hasArchives
                  ? `${enabledSources.length} source${enabledSources.length !== 1 ? 's' : ''} available`
                  : 'No archives enabled'
                }
              </p>
            </div>
          </div>
        </header>

        <div className="flex-1 px-[var(--app-shell-gutter)] py-6">
          <div className="mx-auto max-w-[var(--app-content-max)] space-y-6">

            {/* No archives state */}
            {!loadingSources && !hasArchives && (
              <div className="rounded-xl border border-border/50 bg-card/50 p-8 text-center space-y-4">
                <div className="mx-auto w-12 h-12 rounded-2xl bg-muted flex items-center justify-center">
                  <AlertTriangle size={24} className="text-muted-foreground" />
                </div>
                <div>
                  <div className="text-sm font-medium">No archives enabled</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Enable offline archives in the admin panel to start searching.
                  </div>
                </div>
                <Link
                  to="/admin/knowledge-archives"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <BookOpen size={14} /> Manage Archives
                </Link>
              </div>
            )}

            {/* Search bar + sources */}
            {hasArchives && (
              <>
                <form onSubmit={handleSubmit}>
                  <div className="relative">
                    <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={inputRef}
                      type="text"
                      value={query}
                      onChange={e => handleInput(e.target.value)}
                      placeholder="Search your offline archives…"
                      className="w-full rounded-xl border border-border bg-card/50 py-3.5 pl-11 pr-4 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                    />
                  </div>
                </form>

                {/* Enabled sources chips */}
                <div className="flex flex-wrap gap-2">
                  {enabledSources.map(s => (
                    <span
                      key={s.source_id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-card/50 px-2.5 py-1 text-[11px] text-muted-foreground"
                    >
                      <img
                        src={`${API}/favicon/${s.source_id}`}
                        alt=""
                        className="w-3.5 h-3.5 rounded"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      {s.label}
                    </span>
                  ))}
                </div>
              </>
            )}

            {/* Loading */}
            {loading && (
              <div className="text-sm text-muted-foreground">Searching…</div>
            )}

            {/* No results */}
            {!loading && searched && results.length === 0 && (
              <div className="rounded-xl border border-border/50 bg-card/50 p-6 text-center space-y-2">
                <div className="text-sm text-muted-foreground">
                  {message || `No results for "${query}"`}
                </div>
                <div className="text-xs text-muted-foreground/60">
                  Try different keywords or enable more archives.
                </div>
              </div>
            )}

            {/* Results */}
            {results.length > 0 && (
              <div className="space-y-2">
                {results.map((result, i) => (
                  <Link
                    key={`${result.source_id}-${result.path}-${i}`}
                    to={`/browse/${result.source_id}/${result.path}`}
                    className="block rounded-xl border border-border/50 bg-card/50 p-4 space-y-2 hover:border-primary/30 hover:bg-card/80 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <img
                        src={`${API}/favicon/${result.source_id}`}
                        alt=""
                        className="w-5 h-5 rounded mt-0.5 shrink-0"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground leading-snug">
                          {result.title}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {result.source_label}
                          {result.url && !result.url.startsWith('zim://') && (
                            <span className="ml-2 opacity-60">{result.url}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground leading-relaxed line-clamp-3 pl-8">
                      {result.snippet}
                    </div>
                  </Link>
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
