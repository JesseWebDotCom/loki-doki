import React from "react";
import { ExternalLink } from "lucide-react";

import { Card } from "../ui/card";
import { cn } from "../../lib/utils";
import FaviconImage from "./FaviconImage";
import { getSourcePresentation } from "./sourcePresentation";

/**
 * Structured source shape written by the backend adapter layer.
 *
 * Mirrors ``lokidoki.orchestrator.adapters.base.Source`` minus the
 * Python-only ``relevance``/``page`` surfaces that nothing in the UI
 * reads yet (chunks 17 / 19 will wire those). ``title`` and ``url`` are
 * the only fields guaranteed to be present today — every other column
 * is optional and rendered conditionally.
 */
export interface StructuredSource {
  title: string;
  url: string;
  /** ``web`` | ``doc`` | ``memory`` | ``skill`` | ``local`` — free-form
   *  today; rendered as a small uppercase chip. */
  kind?: string;
  /** Alternative key for ``kind`` as serialized by the Python adapter
   *  (``_source_to_dict`` writes ``type``). Accepting both keeps the
   *  card resilient to either wire shape. */
  type?: string;
  snippet?: string;
  published_at?: string;
  author?: string;
}

interface SourceCardProps {
  source: StructuredSource;
  className?: string;
}

const SNIPPET_MAX_CHARS = 140;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Rich card view of one cited source.
 *
 * Chunk 11 offline-safety rules:
 *
 *   * The favicon goes through :mod:``FaviconImage`` / ``faviconCache``;
 *     if the network is unreachable the cache returns a generated
 *     SVG fallback rather than an ``<img>`` tag pointed at a remote URL.
 *   * The source URL itself is allowed as an ``<a href>`` target — the
 *     user clicking out to a browser tab is user-initiated and not a
 *     runtime fetch.
 *   * No preview-on-hover, no auto-fetch: the card only renders what
 *     the envelope already carried.
 */
const SourceCard: React.FC<SourceCardProps> = ({ source, className }) => {
  const presentation = getSourcePresentation({
    url: source.url,
    title: source.title,
  });
  const snippet = source.snippet ? truncate(source.snippet, SNIPPET_MAX_CHARS) : null;
  const kind = (source.kind || source.type || "").toLowerCase();
  const meta: string[] = [];
  if (source.published_at) meta.push(source.published_at);
  if (source.author) meta.push(source.author);

  return (
    <Card
      className={cn(
        "group/source transition-colors hover:border-primary/40 hover:bg-card/90",
        className,
      )}
    >
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block p-4"
        aria-label={`Open source: ${presentation.sourceName}`}
      >
        <div className="flex items-start gap-3">
          <FaviconImage
            hostname={presentation.hostname}
            remoteUrl={presentation.faviconUrl}
            className="mt-0.5 h-5 w-5 shrink-0 rounded-md bg-muted object-cover"
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-start justify-between gap-3">
              <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
                {source.title || presentation.sourceName}
              </p>
              <ExternalLink
                size={14}
                className="mt-1 shrink-0 text-muted-foreground/70 transition-colors group-hover/source:text-primary"
              />
            </div>
            <p className="truncate text-[11px] font-mono text-muted-foreground/75">
              {presentation.hostname}
            </p>
            {snippet ? (
              <p
                data-slot="source-snippet"
                className="line-clamp-3 text-xs text-muted-foreground"
              >
                {snippet}
              </p>
            ) : null}
            {(kind || meta.length > 0) && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {kind ? (
                  <span
                    data-slot="source-kind"
                    className="rounded-md border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground"
                  >
                    {kind}
                  </span>
                ) : null}
                {meta.length > 0 ? (
                  <span
                    data-slot="source-meta"
                    className="text-[10px] text-muted-foreground/80"
                  >
                    {meta.join(" · ")}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </a>
    </Card>
  );
};

export default SourceCard;
