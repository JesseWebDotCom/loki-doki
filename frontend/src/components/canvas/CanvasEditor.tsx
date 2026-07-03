// CodeMirror 6 editor for the Canvas pane. This module statically imports
// CodeMirror + language packs, so it MUST only ever be reached through a lazy
// import (see ArtifactPane) to keep it out of the main bundle.

import { useMemo } from 'react'
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { githubLight, githubDark } from '@uiw/codemirror-theme-github'
import type { ArtifactType } from '@/lib/canvas/artifactStore'

// Map a language string to a CodeMirror language extension, or null if unknown.
function langFor(language: string): Extension | null {
  const l = language.toLowerCase()
  if (/^(js|jsx|javascript|node|mjs|cjs)$/.test(l)) return javascript({ jsx: true })
  if (/^(ts|tsx|typescript)$/.test(l)) return javascript({ jsx: true, typescript: true })
  if (/^(py|python)$/.test(l)) return python()
  if (/^(css|scss|less)$/.test(l)) return css()
  if (/^html?$/.test(l)) return html()
  if (/^(md|markdown)$/.test(l)) return markdown()
  return null
}

// The model often omits the `language` arg, so a code artifact arrives with no
// language and would render with NO highlighting. Sniff it from the content (cheap,
// first ~2KB) so Python/JS/etc. still colourise.
function detectLang(content: string): string {
  const c = content.slice(0, 2000)
  if (/(^|\n)\s*(def|class)\s+\w+.*:|(^|\n)\s*(import|from)\s+\w+|\bself\b|\bprint\(/.test(c) && !/[{};]\s*$/m.test(c)) return 'python'
  if (/^\s*<!doctype|^\s*<html[\s>]|<\/[a-z]+>/i.test(c)) return 'html'
  if (/(^|\n)\s*#!.*\b(bash|sh)\b|(^|\n)\s*(echo|fi|then|elif|esac)\b/.test(c)) return 'bash'
  if (/\binterface\s+\w+|:\s*(string|number|boolean)\b|\bimport\s+type\b/.test(c)) return 'typescript'
  if (/\b(function|const|let|var)\b|=>|require\(|module\.exports|console\.log/.test(c)) return 'javascript'
  if (/^\s*[.#]?[\w-]+\s*\{[^}]*:/.test(c)) return 'css'
  return ''
}

export default function CanvasEditor({
  value, type, language, onChange, readOnly, dark,
}: {
  value: string
  type: ArtifactType
  language: string | null
  onChange: (v: string) => void
  readOnly?: boolean
  dark?: boolean
}) {
  // Resolve the effective language: explicit wins; else sniff from the content. This
  // recomputes as content streams in, but is only a string - the editor only actually
  // reconfigures when it CHANGES (usually once, '' -> 'python'), via the memo below.
  const resolvedLang = useMemo(() => {
    if (type !== 'code') return type // 'document' | 'html' handled directly
    if (language && langFor(language)) return language
    return detectLang(value)
  }, [type, language, value])

  const extensions = useMemo(() => {
    const ext = type === 'html' ? html()
      : type === 'document' ? markdown()
      : langFor(resolvedLang)
    return [...(ext ? [ext] : []), EditorView.lineWrapping]
  }, [type, resolvedLang])

  return (
    <CodeMirror
      value={value}
      theme={dark ? githubDark : githubLight}
      extensions={extensions}
      editable={!readOnly}
      onChange={onChange}
      basicSetup={{ lineNumbers: type === 'code', foldGutter: type === 'code', highlightActiveLine: !readOnly }}
      height="100%"
      style={{ height: '100%', fontSize: '13px' }}
    />
  )
}
