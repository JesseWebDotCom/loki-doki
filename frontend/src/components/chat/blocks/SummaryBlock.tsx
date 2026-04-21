import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

import type { Block } from "../../../lib/response-types";
import SourceChip from "../SourceChip";
import BlockShell from "./BlockShell";
import { useBlockContext } from "./index";

/**
 * Summary block renderer.
 *
 * Renders ``block.content`` as assistant-prose markdown — same
 * component overrides, citations, and person-mention chips as the old
 * inline ``contentMarkup`` in ``MessageItem``. State chrome is
 * delegated to ``BlockShell`` (skeleton for ``loading``, muted chip for
 * ``failed``, nothing for ``omitted``).
 *
 * ``renderPartial`` is opted in: the streaming-text path (today
 * ``pipeline.streamingResponse``) lands in a ``partial`` block, and we
 * want the in-progress prose to show immediately rather than hide
 * behind a skeleton.
 */
function preprocessContent(content: string): string {
  let processed = content.replace(
    /\s*\[src:(\d+)\]/g,
    "\u00A0[🔗$1](#cite-$1)",
  );
  processed = processed.replace(/\s*\[youtube(?:_channel)?:\d+\]/g, "");
  return processed;
}

const SummaryBlock: React.FC<{ block: Block }> = ({ block }) => {
  const { sources, mentionedPeople } = useBlockContext();
  const content = block.content ?? "";
  const processed = preprocessContent(content);

  return (
    <BlockShell block={block} renderPartial>
      <div className="prose-onyx font-medium tracking-tight text-[1.14rem] leading-9 text-foreground/95 sm:text-[1.36rem] sm:leading-[2.45rem]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            p: ({ children }) => (
              <p className="mb-5 last:mb-0">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="ml-6 mb-5 list-disc space-y-2">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="ml-6 mb-5 list-decimal space-y-2">{children}</ol>
            ),
            li: ({ children }) => (
              <li className="leading-9 sm:leading-[2.45rem]">{children}</li>
            ),
            h1: ({ children }) => (
              <h1 className="mb-5 mt-1 text-[2.35rem] font-bold leading-tight tracking-[-0.04em] text-foreground sm:text-[3.7rem]">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mb-4 mt-1 text-[1.8rem] font-bold leading-tight tracking-[-0.03em] text-foreground sm:text-[2.6rem]">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mb-3 mt-1 text-[1.35rem] font-semibold leading-tight text-foreground sm:text-[1.7rem]">
                {children}
              </h3>
            ),
            strong: ({ children }) => (
              <strong className="font-bold text-primary/90">{children}</strong>
            ),
            a: ({ href, children }) => {
              if (href?.startsWith("#cite-")) {
                const index = parseInt(href.replace("#cite-", ""), 10);
                const source = sources[index - 1];
                if (!source) return null;
                return <SourceChip index={index} source={source} />;
              }
              if (href?.startsWith("/people?focus=")) {
                const personId = parseInt(
                  new URLSearchParams(href.split("?")[1]).get("focus") || "0",
                  10,
                );
                const person = mentionedPeople.find((p) => p.id === personId);
                return (
                  <a
                    href={href}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors no-underline align-middle mx-0.5 cursor-pointer"
                    title={
                      person
                        ? `View ${person.name}'s profile${
                            person.relation ? ` (${person.relation})` : ""
                          }`
                        : "View profile"
                    }
                  >
                    {person?.photo_url ? (
                      <img
                        src={person.photo_url}
                        alt=""
                        className="w-4 h-4 rounded-full object-cover"
                      />
                    ) : (
                      <span className="w-4 h-4 rounded-full bg-primary/20 text-[8px] font-bold flex items-center justify-center">
                        {(String(children) || "?").charAt(0).toUpperCase()}
                      </span>
                    )}
                    {children}
                  </a>
                );
              }
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex cursor-pointer items-center gap-1 font-semibold text-primary underline-offset-4 decoration-primary/30 transition-all hover:underline"
                >
                  {children}
                </a>
              );
            },
            code: ({ children }) => (
              <code className="rounded-md border border-border/20 bg-muted px-1.5 py-0.5 font-mono text-sm">
                {children}
              </code>
            ),
            pre: ({ children }) => (
              <pre className="my-4 overflow-x-auto rounded-2xl border border-border/30 bg-muted p-4 font-mono text-sm shadow-inner">
                {children}
              </pre>
            ),
            blockquote: ({ children }) => (
              <blockquote className="my-4 rounded-r-lg border-l-4 border-primary/30 bg-muted/20 py-1 pl-4 italic text-muted-foreground">
                {children}
              </blockquote>
            ),
          }}
        >
          {processed}
        </ReactMarkdown>
      </div>
    </BlockShell>
  );
};

export default SummaryBlock;
