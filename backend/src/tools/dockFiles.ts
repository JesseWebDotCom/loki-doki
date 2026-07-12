// Companion chat tool: read-only file operations on the user's computer via
// their Doki Dock desktop app. The server round-trips the request over the
// dock's browser-session SSE (sendDockRequest); ALL enforcement — the on/off
// permission, user-picked allowed folders, traversal/symlink checks, secret-path
// denylist, size caps — happens in the dock's Electron main process
// (desktop/src/fileAccess.js). This tool only shapes requests and errors.

import type { Tool, ToolResult } from './index'
import { isDockOnline, sendDockRequest } from '@/lib/pod/browserSession'

const MAX_CONTENT_CHARS = 12_000

const ERROR_TEXT: Record<string, string> = {
  dock_offline: "Doki Dock isn't running on your computer right now, so I can't look at local files. Open the Doki Dock app first.",
  dock_timeout: "Your Doki Dock didn't answer in time. Make sure the app is running and connected, then try again.",
  shell_outdated: 'Your Doki Dock app is too old for file access — update it to the latest version.',
  permission_off: 'Local file access is turned off. In the Doki Dock island, open Settings (gear icon) and turn on "Local file access", then add the folders I may read.',
  no_roots: 'Local file access is on, but no folders are allowed yet. In the Doki Dock island Settings, use "Add folder…" to pick which folders I may read.',
  outside_roots: "That path isn't inside a folder you've allowed. Add its folder in the Doki Dock island Settings if you want me to read it.",
  denied_path: "I can't read that — it looks like a credentials or secrets location, which is always off-limits.",
  not_found: "I couldn't find that path on your computer.",
  bad_path: 'I need a full path, like /Users/you/Documents.',
  not_a_file: "That's a folder, not a file — ask me to list it instead.",
  read_failed: "I couldn't read that file (it may have moved or I don't have OS-level access).",
}

interface ListData {
  entries: Array<{ name: string; path: string; kind: string; size: number; modifiedAt: number }>
  truncated: boolean
}
interface ReadData {
  binary: boolean
  size: number
  name: string
  truncated?: boolean
  content?: string
}

function fmtSize(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export const dockFilesTool: Tool = {
  id: 'dockFiles',
  name: 'Local files (read-only)',
  description: 'List folders and read text files on the user\'s computer through their Doki Dock desktop app — strictly read-only, and only inside folders the user explicitly allowed in the dock settings.',
  offline: true,
  dataSources: [],
  examples: [
    'what is in my downloads folder',
    'list the files on my desktop',
    'read me the notes file on my desktop',
    'open the todo.txt in my documents',
    'what files are in my documents folder',
    'read that readme file in my projects folder',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'dockFiles',
      description: 'Read-only file access on the user\'s computer via the Doki Dock desktop app. action "list" returns a folder\'s entries; action "read" returns a text file\'s contents. Paths must be absolute (e.g. /Users/name/Downloads). Only works inside folders the user allowed, and only while Doki Dock is running.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read'], description: '"list" a folder or "read" a text file.' },
          path: { type: 'string', description: 'Absolute path of the folder or file, e.g. /Users/name/Downloads or ~/Desktop/notes.txt.' },
        },
        required: ['action', 'path'],
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const userId = String(config?.['_userId'] ?? '')
    if (!userId) return { success: false, error: 'No user in this turn.' }
    const { action, path } = (args ?? {}) as { action?: string; path?: string }
    if ((action !== 'list' && action !== 'read' && action !== 'stat') || typeof path !== 'string' || !path.trim()) {
      return { success: false, error: 'Provide action ("list" or "read") and an absolute path.' }
    }
    if (!isDockOnline(userId)) return { success: false, error: ERROR_TEXT.dock_offline! }

    const result = await sendDockRequest(userId, { type: 'files', action, path: path.trim() })
    if (!result.ok) {
      const key = result.error ?? 'read_failed'
      return { success: false, error: ERROR_TEXT[key] ?? ERROR_TEXT.read_failed! }
    }

    if (action === 'list') {
      const data = result.data as ListData
      const lines = data.entries.map((e) =>
        e.kind === 'dir' ? `${e.name}/` : `${e.name} (${fmtSize(e.size)})`)
      return {
        success: true,
        data: {
          path: path.trim(),
          count: data.entries.length,
          truncated: data.truncated,
          listing: lines.join('\n') || '(empty folder)',
          answer_payload: { gist: `${data.entries.length} item${data.entries.length === 1 ? '' : 's'} in ${path.trim()}${data.truncated ? ' (listing truncated)' : ''}.` },
        },
      }
    }

    if (action === 'read') {
      const data = result.data as ReadData
      if (data.binary) {
        return {
          success: true,
          data: { path: path.trim(), binary: true, size: data.size, answer_payload: { gist: `${data.name} is a binary file (${fmtSize(data.size)}) — I can only read text files.` } },
        }
      }
      let content = data.content ?? ''
      let truncated = data.truncated === true
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS)
        truncated = true
      }
      return {
        success: true,
        data: {
          path: path.trim(),
          name: data.name,
          size: data.size,
          truncated,
          content: truncated ? `${content}\n\n[…truncated — the file continues]` : content,
        },
      }
    }

    // stat
    return { success: true, data: { path: path.trim(), stat: result.data } }
  },
}
