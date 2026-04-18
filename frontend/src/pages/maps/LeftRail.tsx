/**
 * Apple Maps-style left rail.
 *
 * Brand mark + BETA chip at the top, three nav items (Search / Guides /
 * Directions), a collapsible Recents list seeded from
 * localStorage, and a footer card linking to Settings → Maps.
 *
 * Active-panel state lives on `MapsPage`; this component is a pure
 * presentational surface with keyboard-accessible tab semantics.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LayoutGrid,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from 'lucide-react';
import Badge from '@/components/ui/Badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ActivePanel, PlaceResult, Recent } from './types';

export interface LeftRailProps {
  active: ActivePanel;
  onSelectPanel: (panel: Exclude<ActivePanel, null>) => void;
  recents: Recent[];
  onSelectRecent: (place: PlaceResult) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

interface NavItem {
  key: Exclude<ActivePanel, null>;
  label: string;
  Icon: typeof Search;
  disabled?: boolean;
  tooltip?: string;
}

const NAV: NavItem[] = [
  { key: 'search', label: 'Search', Icon: Search },
  {
    key: 'guides',
    label: 'Guides',
    Icon: LayoutGrid,
    disabled: true,
    tooltip: 'Coming soon',
  },
  { key: 'directions', label: 'Directions', Icon: ArrowRightLeft },
];

const LeftRail: React.FC<LeftRailProps> = ({
  active,
  onSelectPanel,
  recents,
  onSelectRecent,
  collapsed,
  onToggleCollapsed,
}) => {
  const [recentsOpen, setRecentsOpen] = useState(true);

  return (
    <aside
      aria-label="Maps navigation"
      className={cn(
        'flex h-full flex-col border-r border-border/30 bg-card/80 backdrop-blur transition-[width]',
        collapsed ? 'w-[72px]' : 'w-full',
      )}
    >
      {/* Brand row */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        {!collapsed ? (
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/20 text-primary-foreground shadow-inner">
              <MapPin size={14} />
            </div>
            <span className="text-base font-semibold tracking-tight">Maps</span>
            <Badge>Beta</Badge>
          </div>
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/20 text-primary-foreground shadow-inner mx-auto">
            <MapPin size={14} />
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-card"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* Nav tabs */}
      <nav
        role="tablist"
        aria-label="Maps sections"
        className="flex flex-col gap-1 px-2 py-1"
      >
        {NAV.map((item) => {
          const isActive = active === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={item.label}
              disabled={item.disabled}
              title={item.tooltip ?? item.label}
              onClick={() => !item.disabled && onSelectPanel(item.key)}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer',
                isActive
                  ? 'bg-primary/15 text-primary-foreground shadow-m2'
                  : 'text-muted-foreground hover:text-foreground hover:bg-card',
                item.disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground',
                collapsed && 'justify-center px-2',
              )}
            >
              <item.Icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Recents */}
      {!collapsed && (
        <div className="mt-2 flex min-h-0 flex-1 flex-col px-2">
          <Collapsible open={recentsOpen} onOpenChange={setRecentsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <span>Recents</span>
                {recentsOpen ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {recents.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground/80">
                  No places yet — pick a search result to see it here.
                </div>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {recents.slice(0, 5).map((r) => (
                    <li key={r.place_id}>
                      <button
                        type="button"
                        onClick={() => onSelectRecent(r)}
                        className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-card transition-colors cursor-pointer"
                      >
                        <MapPin
                          size={13}
                          className="mt-0.5 shrink-0 text-destructive"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-foreground">
                            {r.title}
                          </div>
                          {r.subtitle && (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {r.subtitle}
                            </div>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {/* Footer */}
      {!collapsed && (
        <div className="mt-auto p-3">
          <Link
            to="/settings?section=maps"
            className="flex items-center justify-between rounded-xl border border-border/30 bg-card/60 px-3 py-2.5 text-xs text-foreground transition-colors hover:bg-card"
          >
            <div className="flex flex-col">
              <span className="font-medium">Manage map regions</span>
              <span className="text-[10px] text-muted-foreground">
                Install, update, remove
              </span>
            </div>
            <ExternalLink size={13} className="text-muted-foreground" />
          </Link>
        </div>
      )}
    </aside>
  );
};

export default LeftRail;
