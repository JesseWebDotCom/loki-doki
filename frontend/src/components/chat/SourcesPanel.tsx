import React from 'react';
import { ExternalLink, Search, X } from 'lucide-react';
import type { SourceInfo } from '../../lib/api';
import { cn } from '../../lib/utils';
import { getSourcePresentation } from './sourcePresentation';
import FaviconImage from './FaviconImage';

interface SourcesPanelProps {
  open: boolean;
  title?: string;
  sources: SourceInfo[];
  onClose: () => void;
}

const SourcesPanel: React.FC<SourcesPanelProps> = ({ open, title, sources, onClose }) => {
  return (
    <>
      <button
        type="button"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={cn(
          'absolute inset-0 z-20 bg-background/35 backdrop-blur-[1px] transition-opacity sm:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        className={cn(
          'absolute inset-y-0 right-0 z-30 flex w-full max-w-[380px] flex-col border-l border-border/40 bg-card/95 backdrop-blur-xl transition-transform duration-300 sm:w-[380px]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b border-border/40 px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Search size={17} />
              <span className="text-xs font-bold uppercase tracking-[0.22em]">Cited Sources</span>
            </div>
            {title ? (
              <p className="mt-2 truncate text-sm font-medium text-foreground/80">{title}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close sources panel"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="space-y-3">
            {sources.map((source, index) => {
              const presentation = getSourcePresentation(source);
              return (
                <a
                  key={`${source.url}-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-2xl border border-border/40 bg-background/55 p-4 transition-colors hover:border-primary/30 hover:bg-background/75"
                >
                  <div className="flex items-start gap-3">
                    <FaviconImage
                      hostname={presentation.hostname}
                      remoteUrl={presentation.faviconUrl}
                      className="mt-0.5 h-5 w-5 rounded-md bg-card object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
                          {presentation.label}
                        </p>
                        <ExternalLink size={14} className="mt-1 shrink-0 text-muted-foreground" />
                      </div>
                      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{source.title}</p>
                      <p className="mt-2 truncate text-xs text-muted-foreground/75">{source.url}</p>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      </aside>
    </>
  );
};

export default SourcesPanel;
