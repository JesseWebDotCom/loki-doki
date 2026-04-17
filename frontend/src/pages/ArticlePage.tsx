/**
 * ArticlePage — offline article viewer with theme-matched rendering.
 *
 * Lives inside the app shell (sidebar visible). Fetches a ZIM article
 * as markdown and renders it through ProseRenderer.
 */
import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, List } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import ProseRenderer from '../components/ProseRenderer';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const API = '/api/v1/archives';

interface TocEntry {
  level: number;
  title: string;
  slug: string;
}

interface ArticleData {
  source_id: string;
  title: string;
  path: string;
  markdown: string;
  toc: TocEntry[];
  url: string;
  source_label: string;
}

const ArticlePage: React.FC = () => {
  const { sourceId, '*': articlePath } = useParams<{ sourceId: string; '*': string }>();
  const navigate = useNavigate();
  const [article, setArticle] = useState<ArticleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showToc, setShowToc] = useState(false);

  useDocumentTitle(article?.title ?? 'Article');

  useEffect(() => {
    if (!sourceId || !articlePath) return;

    setLoading(true);
    setError('');
    fetch(`${API}/article/${sourceId}/${articlePath}`)
      .then(async res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then(data => {
        setArticle(data);
        window.scrollTo(0, 0);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [sourceId, articlePath]);

  // Handle internal link clicks for wiki navigation
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (href?.startsWith(`/browse/${sourceId}/`)) {
        e.preventDefault();
        navigate(href);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [sourceId, navigate]);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main className="flex-1 flex flex-col bg-background overflow-y-auto">

        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading article…</div>
          </div>
        )}

        {!loading && (error || !article) && (
          <div className="px-[var(--app-shell-gutter)] py-12">
            <div className="mx-auto max-w-[var(--app-content-max)]">
              <Link to="/search" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6">
                <ArrowLeft size={14} /> Back to search
              </Link>
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
                <div className="text-sm text-destructive">{error || 'Article not found'}</div>
              </div>
            </div>
          </div>
        )}

        {!loading && article && (
          <>
            {/* Sticky header bar */}
            <div className="sticky top-0 z-10 border-b border-border/10 bg-background/80 backdrop-blur-sm px-[var(--app-shell-gutter)] py-3">
              <div className="mx-auto max-w-[var(--app-content-max)] flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <Link to="/search" className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
                    <ArrowLeft size={18} />
                  </Link>
                  <img
                    src={`${API}/favicon/${article.source_id}`}
                    alt=""
                    className="w-5 h-5 rounded shrink-0"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{article.title}</div>
                    <div className="text-[10px] text-muted-foreground">{article.source_label}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {article.toc.length > 0 && (
                    <button
                      onClick={() => setShowToc(!showToc)}
                      className={`rounded-lg border p-2 transition-colors ${
                        showToc ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                      title="Table of contents"
                    >
                      <List size={14} />
                    </button>
                  )}
                  {article.url && !article.url.startsWith('zim://') && (
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground transition-colors"
                      title="View online"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* Article body */}
            <div className="flex-1 px-[var(--app-shell-gutter)] py-8">
              <div className="mx-auto max-w-[var(--app-content-max)] flex gap-8">
                {/* TOC sidebar */}
                {showToc && article.toc.length > 0 && (
                  <aside className="hidden lg:block w-56 shrink-0 sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto">
                    <div className="rounded-xl border border-border/50 bg-card/50 p-3 space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Contents</div>
                      {article.toc.map((entry, i) => (
                        <a
                          key={i}
                          href={`#${entry.slug}`}
                          className="block text-xs text-muted-foreground hover:text-foreground transition-colors truncate"
                          style={{ paddingLeft: `${(entry.level - 1) * 12}px` }}
                        >
                          {entry.title}
                        </a>
                      ))}
                    </div>
                  </aside>
                )}

                {/* Content */}
                <article className="flex-1 min-w-0">
                  <h1 className="text-3xl font-bold tracking-tight text-foreground mb-8">
                    {article.title}
                  </h1>
                  <ProseRenderer
                    markdown={article.markdown}
                    sourceId={article.source_id}
                  />
                </article>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default ArticlePage;
