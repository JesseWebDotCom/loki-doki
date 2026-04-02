import { Link } from 'react-router-dom';

import CharacterWorkspace from '@/character-editor/integration/CharacterWorkspace';

export default function LabHome() {
  return (
    <CharacterWorkspace>
      <div className="max-w-3xl mx-auto space-y-8 py-12 px-4 select-none">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-sky-700 shadow-xl shadow-sky-600/20 flex items-center justify-center shrink-0 border border-white/20">
              <div className="w-6 h-6 rounded-full bg-slate-900 border-2 border-white/20 animate-pulse" />
            </div>
            <div className="flex flex-col">
              <h1 className="font-bold text-2xl text-slate-100 tracking-tight leading-none mb-1">
                LokiDoki Character Editor
              </h1>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                Native Editor Workspace
              </p>
            </div>
          </div>

          <div className="h-px bg-gradient-to-r from-slate-700/50 via-slate-700/50 to-transparent w-full mt-4" />
        </div>

        <div className="grid grid-cols-1 gap-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-sky-600 shadow-lg shadow-sky-600/10 shrink-0 border border-white/10" />
            <div className="flex flex-col p-4 rounded-2xl max-w-[80%] border bg-sky-500/5 border-sky-500/20 text-slate-200">
              <p className="text-sm leading-relaxed">
                This is the native LokiDoki workspace for creating, previewing,
                and exporting character packages directly from the main app.
              </p>
              <span className="text-[10px] font-bold text-slate-500 mt-3 uppercase tracking-tighter self-end">
                LokiDoki • System
              </span>
            </div>
          </div>

          <div className="flex">
            <Link
              to="/editor"
              className="inline-flex items-center justify-center rounded-xl bg-sky-500 px-4 py-2 text-sm font-black text-slate-950 transition-colors hover:bg-sky-400"
            >
              Open Character Editor
            </Link>
          </div>
        </div>
      </div>
    </CharacterWorkspace>
  );
}
