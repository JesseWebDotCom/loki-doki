/**
 * ProseRenderer — shared markdown renderer with Onyx Material styling.
 *
 * Used by both the article browser and potentially the search page
 * for rich content display. Uses the same react-markdown + remark-gfm
 * stack as chat messages but with article-optimized typography.
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  markdown: string;
  className?: string;
  /** When set, internal wiki links are rewritten to /browse/{sourceId}/{path} */
  sourceId?: string;
}

const ProseRenderer: React.FC<Props> = ({ markdown, className = '', sourceId }) => {
  return (
    <div className={`prose-onyx text-[0.95rem] leading-7 text-foreground/90 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="ml-6 mb-4 list-disc space-y-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="ml-6 mb-4 list-decimal space-y-1.5">{children}</ol>,
          li: ({ children }) => <li className="leading-7">{children}</li>,
          h1: ({ children }) => <h1 className="mb-4 mt-8 text-2xl font-bold tracking-tight text-foreground">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-7 text-xl font-bold tracking-tight text-foreground">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-6 text-lg font-semibold text-foreground">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-2 mt-5 text-base font-semibold text-foreground">{children}</h4>,
          strong: ({ children }) => <strong className="font-bold text-foreground">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-primary/30 pl-4 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          code: ({ children, className: codeClass }) => {
            const isBlock = codeClass?.startsWith('language-');
            if (isBlock) {
              return (
                <pre className="my-4 overflow-x-auto rounded-lg border border-border/50 bg-card/50 p-4">
                  <code className="text-xs leading-5 text-foreground">{children}</code>
                </pre>
              );
            }
            return (
              <code className="rounded bg-card/80 border border-border/30 px-1.5 py-0.5 text-[0.85em] text-foreground">
                {children}
              </code>
            );
          },
          a: ({ href, children }) => {
            // Rewrite internal wiki links to browse routes
            if (sourceId && href && !href.startsWith('http') && !href.startsWith('#')) {
              const browsePath = `/browse/${sourceId}/${href.replace(/^\//, '')}`;
              return (
                <a href={browsePath} className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors">
                  {children}
                </a>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border/50 bg-card/50 px-3 py-2 text-left text-xs font-semibold text-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border/50 px-3 py-2 text-xs text-foreground/80">
              {children}
            </td>
          ),
          hr: () => <hr className="my-6 border-border/30" />,
          img: ({ src, alt }) => {
            // Rewrite image paths to serve from ZIM media endpoint
            const imgSrc = sourceId && src && !src.startsWith('http')
              ? `/api/v1/archives/media/${sourceId}/${src.replace(/^\//, '')}`
              : src;
            return (
              <img
                src={imgSrc}
                alt={alt || ''}
                className="my-4 max-w-full rounded-lg"
                loading="lazy"
              />
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
};

export default ProseRenderer;
