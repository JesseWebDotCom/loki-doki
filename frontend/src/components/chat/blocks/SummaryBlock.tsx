import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

import type { Block } from "../../../lib/response-types";
import { stabilizeStreamingMarkdown } from "../../../utils/markdownStabilizer";
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
  // Strip the ``<spoken_text>...</spoken_text>`` island the LLM
  // appends for voice parity (design §20.3). The backend strips this
  // at the final ResponseObject boundary, but during streaming the
  // tag lands in the block's content token-by-token. Also drop an
  // unterminated opening tag so the in-progress render stays clean.
  let processed = content.replace(/\s*<spoken_text>[\s\S]*?<\/spoken_text>/gi, "");
  processed = processed.replace(/\s*<spoken_text>[\s\S]*$/i, "");
  processed = processed.replace(
    /\s*\[src:(\d+)\]/g,
    "\u00A0[🔗$1](#cite-$1)",
  );
  processed = processed.replace(/\s*\[youtube(?:_channel)?:\d+\]/g, "");
  return processed;
}

const SummaryBlock: React.FC<{ block: Block }> = ({ block }) => {
  const { sources, mentionedPeople, envelopeStatus } = useBlockContext();
  const content = block.content ?? "";
  const markdownSource =
    envelopeStatus === "streaming" && block.state !== "ready"
      ? stabilizeStreamingMarkdown(content)
      : content;
  const processed = preprocessContent(markdownSource);
  const shouldRenderContent = processed.trim().length > 0;
  const showCaret =
    envelopeStatus === "streaming" &&
    block.state !== "ready" &&
    shouldRenderContent;

  if (!shouldRenderContent) {
    return <BlockShell block={block} renderPartial />;
  }

  return (
    <BlockShell block={block} renderPartial={shouldRenderContent}>
      <div className="prose-onyx font-medium tracking-tight text-base leading-7 text-foreground/95 sm:text-[1.05rem] sm:leading-8">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            p: ({ children }) => (
              <p className="mb-4 last:mb-0">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="ml-6 mb-4 list-disc space-y-1.5">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="ml-6 mb-4 list-decimal space-y-1.5">{children}</ol>
            ),
            li: ({ children }) => (
              <li className="leading-7 sm:leading-8">{children}</li>
            ),
            h1: ({ children }) => (
              <h1 className="mb-4 mt-1 text-[1.65rem] font-bold leading-tight tracking-[-0.02em] text-foreground sm:text-[1.95rem]">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mb-3 mt-1 text-[1.3rem] font-bold leading-tight tracking-[-0.01em] text-foreground sm:text-[1.5rem]">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mb-2 mt-1 text-[1.1rem] font-semibold leading-tight text-foreground sm:text-[1.2rem]">
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
        {showCaret ? (
          <span
            aria-hidden="true"
            className="opacity-50 animate-pulse"
          >
            ▍
          </span>
        ) : null}
      </div>
    </BlockShell>
  );
};

export default SummaryBlock;
