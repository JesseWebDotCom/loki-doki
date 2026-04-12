/**
 * AdminPanelLayout — Onyx-inspired left rail + main pane.
 *
 * Owns NO routing knowledge of which sections exist globally — the
 * caller passes the slice of groups visible on this page (Settings,
 * Admin, or Dev), plus the base path for nav links. Only one section
 * is visible at a time.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Search, LogOut, Ghost } from 'lucide-react';
import ProfileMenu from '../components/sidebar/ProfileMenu';
import { SECTIONS, type SectionDef } from './sections';

interface AdminPanelLayoutProps {
  /** Section group names to render in the rail (e.g., ['Personalization']). */
  allowedGroups: string[];
  /** URL prefix for nav links (e.g., '/settings'). */
  basePath: string;
  /** Brand label shown next to the logo. */
  pageLabel: string;
  /** Renders the body for the active section. */
  renderSection: (section: SectionDef) => React.ReactNode;
}

const AdminPanelLayout: React.FC<AdminPanelLayoutProps> = ({
  allowedGroups,
  basePath,
  pageLabel,
  renderSection,
}) => {
  const navigate = useNavigate();
  const { section: sectionParam } = useParams<{ section: string }>();

  const allowedSections = useMemo(
    () => SECTIONS.filter((s) => allowedGroups.includes(s.group)),
    [allowedGroups],
  );

  const active =
    allowedSections.find((s) => s.id === sectionParam) ?? allowedSections[0];

  // Fall back to first allowed section if URL is bare or invalid.
  useEffect(() => {
    if (!sectionParam || !allowedSections.find((s) => s.id === sectionParam)) {
      if (allowedSections[0]) {
        navigate(`${basePath}/${allowedSections[0].id}`, { replace: true });
      }
    }
  }, [sectionParam, allowedSections, basePath, navigate]);

  const [query, setQuery] = useState('');

  // Tab title: "LokiDoki · {section title}".
  useEffect(() => {
    if (!active) return;
    document.title = `LokiDoki · ${active.title}`;
    return () => { document.title = 'LokiDoki'; };
  }, [active]);

  const groupedSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allowedGroups
      .map((g) => ({
        heading: g,
        items: allowedSections
          .filter((s) => s.group === g)
          .filter((s) => !q || s.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length > 0);
  }, [query, allowedGroups, allowedSections]);

  if (!active) return null;
  const ActiveIcon = active.icon;
  const contentWidthClass = active.fullWidth ? 'max-w-none' : 'max-w-5xl';

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <aside
        className="border-r border-sidebar-border bg-sidebar flex flex-col h-screen select-none shadow-m4 z-20 overflow-hidden"
        style={{ width: '17rem' }}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-2">
          <div className="p-1.5 rounded-lg bg-primary/10 border border-primary/20 text-primary shadow-m1">
            <Ghost className="w-5 h-5" />
          </div>
          <span className="text-lg font-bold tracking-tight text-sidebar-foreground">lokidoki</span>
        </div>
        <div className="px-5 pb-4 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
          {pageLabel}
        </div>

        <div className="px-4 pb-4">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              className="w-full rounded-xl border border-border/40 bg-card/40 py-2.5 pl-10 pr-3 text-sm font-medium placeholder:text-muted-foreground/60 transition-all focus:border-primary/40 focus:bg-card/60 focus:outline-none"
            />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto no-scrollbar px-2 pb-4 space-y-5">
          {groupedSections.map((group) => (
            <div key={group.heading}>
              <div className="mb-2 px-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
                {group.heading}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive = item.id === active.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => navigate(`${basePath}/${item.id}`)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
                      }`}
                    >
                      <Icon size={16} className="shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-1 border-t border-sidebar-border/40 px-2 py-3">
          <Link
            to="/"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-card/50 hover:text-foreground"
          >
            <LogOut size={16} />
            <span>Back to Chat</span>
          </Link>
          <div className="px-1">
            <ProfileMenu />
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col relative bg-background shadow-inner overflow-y-auto">
        <header className="border-b border-border/10 px-[var(--app-shell-gutter)] pt-10 pb-8 sm:pt-12">
          <div className={`${contentWidthClass} mx-auto flex items-center gap-4`} style={{ maxWidth: active.fullWidth ? undefined : 'var(--app-content-max)' }}>
            <div className="p-3 rounded-2xl bg-card/40 border border-border/40 text-foreground/70 shadow-m1">
              <ActiveIcon size={26} />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{active.title}</h1>
              <p className="text-base font-medium text-muted-foreground">{active.description}</p>
            </div>
          </div>
          <div className={`${contentWidthClass} mx-auto mt-8 border-b border-border/20`} />
        </header>

        <section className="flex-1 px-[var(--app-shell-gutter)] pb-16 pt-8">
          <div className={`${contentWidthClass} mx-auto`} style={{ maxWidth: active.fullWidth ? undefined : 'var(--app-content-max)' }}>
            {renderSection(active)}
          </div>
        </section>
      </main>
    </div>
  );
};

export default AdminPanelLayout;
