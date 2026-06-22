import { memo, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CitationChip } from './CitationChip'
import { transformCitations } from '@/lib/transformCitations'
import type { Source } from '@/lib/transformCitations'

// ── Code block ────────────────────────────────────────────────────────────────

function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-border/20 text-[13px]">
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#1e1e1e] border-b border-white/5">
        <span className="font-mono text-[11px] text-white/30">{language || 'plaintext'}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors"
        >
          {copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={vscDarkPlus}
        PreTag="div"
        customStyle={{ margin: 0, borderRadius: 0, background: '#1e1e1e', padding: '14px 16px', fontSize: '13px', lineHeight: '1.6' }}
        wrapLongLines
      >
        {children}
      </SyntaxHighlighter>
    </div>
  )
}

// ── Paragraph-level memoization ───────────────────────────────────────────────
// Completed blocks are frozen — only the trailing incomplete block re-renders
// on each streaming token, keeping rendering O(1) not O(n²).
// sourcesLen triggers one re-render when sources arrive so citation chips appear.

interface BlockProps {
  text: string
  sourcesLen: number
  components: Record<string, unknown>
  plugins: { remark: unknown[]; rehype: unknown[] }
}

const MemoBlock = memo(
  function MarkdownBlock({ text, components, plugins }: BlockProps) {
    return (
      <ReactMarkdown
        remarkPlugins={plugins.remark as never[]}
        rehypePlugins={plugins.rehype as never[]}
        components={components as never}
      >
        {text}
      </ReactMarkdown>
    )
  },
  (prev, next) => prev.text === next.text && prev.sourcesLen === next.sourcesLen,
)

// ── Block splitter ────────────────────────────────────────────────────────────
// Splits on double blank lines. Code fences are tracked to avoid splitting inside them.

function splitParagraphs(text: string): string[] {
  const blocks: string[] = []
  const lines = text.split('\n')
  let current = ''
  let inFence = false
  let inMath = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line)) inFence = !inFence
    if (/^\$\$/.test(line)) inMath = !inMath

    // A blank line followed by another blank line = paragraph boundary
    if (!inFence && !inMath && line === '' && i + 1 < lines.length && lines[i + 1] === '') {
      if (current.trim()) blocks.push(current.trimEnd())
      current = ''
      i++ // skip the second blank line
    } else {
      current += (current ? '\n' : '') + line
    }
  }
  if (current.trim()) blocks.push(current.trimEnd())
  return blocks.length ? blocks : [text]
}

// ── Public component ──────────────────────────────────────────────────────────

interface MarkdownRendererProps {
  content: string
  isStreaming?: boolean
  sources?: Source[]
  className?: string
}

export function MarkdownRenderer({ content, isStreaming, sources = [], className }: MarkdownRendererProps) {
  const components = useMemo(() => ({
    // Handles both fenced code blocks and the CITE:N citation carrier (inline code)
    code({ className: cls, children }: { className?: string; children?: React.ReactNode }) {
      // Fenced code block (has a language class)
      const langMatch = /language-(\w+)/.exec(cls || '')
      if (langMatch) {
        return (
          <CodeBlock language={langMatch[1]}>
            {String(children).replace(/\n$/, '')}
          </CodeBlock>
        )
      }

      // Citation chip — injected by transformCitations as `CITE:N`
      const citeMatch = /^CITE:(\d+)$/.exec(String(children).trim())
      if (citeMatch) {
        const n = parseInt(citeMatch[1], 10)
        const source = sources[n - 1]
        return source ? <CitationChip n={n} source={source} /> : <sup className="text-violet-400 text-[0.75em]">[{n}]</sup>
      }

      // Regular inline code
      return (
        <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground/90">
          {children}
        </code>
      )
    },

    p({ children }: { children?: React.ReactNode }) {
      return <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
    },

    h1({ children }: { children?: React.ReactNode }) { return <h2 className="mb-2 mt-4 text-base font-bold">{children}</h2> },
    h2({ children }: { children?: React.ReactNode }) { return <h3 className="mb-2 mt-4 text-[0.95rem] font-bold">{children}</h3> },
    h3({ children }: { children?: React.ReactNode }) { return <h4 className="mb-1 mt-3 text-sm font-semibold">{children}</h4> },

    ul({ children }: { children?: React.ReactNode }) { return <ul className="mb-3 ml-4 list-disc space-y-1 last:mb-0">{children}</ul> },
    ol({ children }: { children?: React.ReactNode }) { return <ol className="mb-3 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol> },
    li({ children }: { children?: React.ReactNode }) { return <li className="leading-relaxed">{children}</li> },

    blockquote({ children }: { children?: React.ReactNode }) {
      return (
        <blockquote className="my-2 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground italic">
          {children}
        </blockquote>
      )
    },

    hr() { return <hr className="my-4 border-border/40" /> },
    strong({ children }: { children?: React.ReactNode }) { return <strong className="font-semibold">{children}</strong> },
    em({ children }: { children?: React.ReactNode }) { return <em className="italic">{children}</em> },

    a({ href, children }: { href?: string; children?: React.ReactNode }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="text-violet-400 underline underline-offset-2 hover:text-violet-300 transition-colors">
          {children}
        </a>
      )
    },

    // GFM tables
    table({ children }: { children?: React.ReactNode }) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-border/50">
          <table className="min-w-full divide-y divide-border/50 text-[13px]">{children}</table>
        </div>
      )
    },
    thead({ children }: { children?: React.ReactNode }) { return <thead className="bg-muted/40">{children}</thead> },
    tbody({ children }: { children?: React.ReactNode }) { return <tbody className="divide-y divide-border/30">{children}</tbody> },
    tr({ children }: { children?: React.ReactNode }) { return <tr className="hover:bg-muted/20 transition-colors">{children}</tr> },
    th({ children }: { children?: React.ReactNode }) {
      return <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</th>
    },
    td({ children }: { children?: React.ReactNode }) { return <td className="px-3 py-2 leading-relaxed">{children}</td> },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sources]) // Rebuild when sources change so citation chips get the right data

  const plugins = useMemo(() => ({ remark: [remarkGfm, remarkMath], rehype: [rehypeKatex] }), [])

  // Apply citation transform — backtick-wraps [N] markers for the `code` component to intercept
  const processedContent = useMemo(
    () => sources.length > 0 ? transformCitations(content, sources) : content,
    [content, sources],
  )

  // Split into paragraph blocks for memoization
  const paragraphs = useMemo(() => splitParagraphs(processedContent), [processedContent])

  const completedBlocks = isStreaming ? paragraphs.slice(0, -1) : paragraphs
  const activeBlock = isStreaming ? (paragraphs[paragraphs.length - 1] ?? '') : null

  return (
    <div className={cn('text-sm leading-relaxed', className)}>
      {completedBlocks.map((block, i) => (
        <MemoBlock
          key={i}
          text={block}
          sourcesLen={sources.length}
          components={components}
          plugins={plugins}
        />
      ))}
      {activeBlock !== null && (
        <ReactMarkdown
          remarkPlugins={plugins.remark as never[]}
          rehypePlugins={plugins.rehype as never[]}
          components={components as never}
        >
          {activeBlock}
        </ReactMarkdown>
      )}

      {isStreaming && (
        <span className="inline-block ml-0.5 h-[1em] w-[3px] align-middle bg-foreground animate-[streaming-cursor_1s_step-end_infinite]" />
      )}
    </div>
  )
}
