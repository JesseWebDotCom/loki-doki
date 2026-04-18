/**
 * VoicesSection — admin panel for uploading, testing, and managing
 * Piper TTS voice models (.onnx + .onnx.json pairs).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download, Loader2, PauseCircle, Play, Plus,
  Trash2, Upload, Volume2, X,
} from 'lucide-react';
import ConfirmDialog from '../ui/ConfirmDialog';

const API = '/api/v1/audio/voices';

interface VoiceInfo {
  voice_id: string;
  display_name: string;
  description: string;
  has_config: boolean;
  model_size: number;
  config_size: number;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
};

const VoicesSection: React.FC = () => {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(API, { credentials: 'include' });
      if (r.ok) {
        const data = await r.json();
        setVoices(data.voices ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    await fetch(`${API}/${pendingDelete}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    setPendingDelete(null);
    void load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 border-b border-border/10 pb-4">
        <Volume2 className="text-primary w-5 h-5" />
        <h2 className="text-xl font-bold tracking-tight">Voice Library</h2>
        <span className="text-[10px] font-bold text-muted-foreground bg-card/60 px-2 py-0.5 rounded-md border border-border/30 ml-2">
          {voices.length} INSTALLED
        </span>
        <button
          onClick={() => setShowUpload(true)}
          className="ml-auto inline-flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/15"
        >
          <Plus size={14} /> Upload Voice
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Upload Piper TTS voice models (.onnx + .onnx.json) to expand the voice library.
        Test each voice with custom text before assigning it.
      </p>

      {loading ? (
        <div className="text-xs text-muted-foreground italic py-12 text-center">Loading voices...</div>
      ) : voices.length === 0 ? (
        <div className="text-xs text-muted-foreground italic py-12 text-center">
          No voices installed. Upload a Piper voice to get started.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {voices.map((v) => (
            <VoiceCard
              key={v.voice_id}
              voice={v}
              onDelete={() => setPendingDelete(v.voice_id)}
              onMetaUpdate={load}
            />
          ))}
        </div>
      )}

      {showUpload && (
        <UploadDialog
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); void load(); }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete voice?"
        description={`This will permanently remove "${pendingDelete}" and its model files. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

// ── Voice Card ──────────────────────────────────────────────────

const VoiceCard: React.FC<{
  voice: VoiceInfo;
  onDelete: () => void;
  onMetaUpdate: () => void;
}> = ({ voice, onDelete, onMetaUpdate }) => {
  const [testText, setTestText] = useState('Hello, this is a test of my voice.');
  const [synthesizing, setSynthesizing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(voice.display_name);
  const [editDesc, setEditDesc] = useState(voice.description);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlaying(false);
  };

  const testVoice = async () => {
    if (playing) { stopAudio(); return; }
    setError(null);
    setSynthesizing(true);

    try {
      const form = new FormData();
      form.append('text', testText);
      form.append('speech_rate', '1.0');

      const r = await fetch(`${API}/${voice.voice_id}/test`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!r.ok) {
        // Backend returns JSON error for non-200, WAV for 200.
        const data = await r.json().catch(() => ({ detail: `Test failed (${r.status})` }));
        throw new Error(data.detail || `Test failed (${r.status})`);
      }

      // Revoke old URL to free memory.
      if (audioUrl) URL.revokeObjectURL(audioUrl);

      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setSynthesizing(false);

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      audio.onerror = () => { setPlaying(false); setError('Playback failed'); };
      setPlaying(true);
      await audio.play();
    } catch (e) {
      setError((e as Error).message);
      setSynthesizing(false);
      setPlaying(false);
    }
  };

  const downloadAudio = () => {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = `${voice.voice_id}_test.wav`;
    a.click();
  };

  const saveMeta = async () => {
    await fetch(`${API}/${voice.voice_id}/meta`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: editName,
        description: editDesc,
      }),
    });
    setEditing(false);
    onMetaUpdate();
  };

  return (
    <div className="rounded-2xl border border-border/30 bg-card/50 p-5 shadow-m1 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Display name"
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-1.5 text-sm font-bold focus:outline-none focus:border-primary/50"
              />
              <input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description (optional)"
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-primary/50"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void saveMeta()}
                  className="text-xs px-3 py-1 rounded-lg bg-primary/10 border border-primary/30 text-primary font-bold"
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditing(false); setEditName(voice.display_name); setEditDesc(voice.description); }}
                  className="text-xs px-3 py-1 rounded-lg bg-card border border-border/30 text-muted-foreground font-bold"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={() => setEditing(true)}
                className="text-left group"
              >
                <h3 className="text-sm font-bold truncate group-hover:text-primary transition-colors">
                  {voice.display_name}
                </h3>
              </button>
              {voice.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{voice.description}</p>
              )}
            </>
          )}
          <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
            <span className="font-mono">{voice.voice_id}</span>
            <span>{formatBytes(voice.model_size)}</span>
          </div>
        </div>
        <button
          onClick={onDelete}
          className="p-2 rounded-lg hover:bg-red-400/10 text-muted-foreground hover:text-red-400 transition-colors"
          title="Delete voice"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Test Area */}
      <div className="space-y-3">
        <textarea
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          placeholder="Type text to test this voice..."
          rows={2}
          className="w-full bg-background/50 border border-border/30 rounded-xl p-3 text-sm resize-none focus:outline-none focus:border-primary/30"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void testVoice()}
            disabled={!testText.trim() || synthesizing}
            className="inline-flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-4 py-2 text-xs font-bold text-primary transition-colors hover:bg-primary/15 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {synthesizing ? (
              <><Loader2 size={14} className="animate-spin" /> Synthesizing...</>
            ) : playing ? (
              <><PauseCircle size={14} /> Stop</>
            ) : (
              <><Play size={14} /> Test Voice</>
            )}
          </button>
          {audioUrl && (
            <button
              onClick={downloadAudio}
              className="inline-flex items-center gap-2 rounded-xl border border-border/30 bg-card/50 px-4 py-2 text-xs font-bold text-muted-foreground transition-colors hover:text-foreground hover:border-border/50"
            >
              <Download size={14} /> Download WAV
            </button>
          )}
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
};

// ── Upload Dialog ───────────────────────────────────────────────

const UploadDialog: React.FC<{
  onClose: () => void;
  onUploaded: () => void;
}> = ({ onClose, onUploaded }) => {
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async () => {
    if (!modelFile || !configFile) return;
    setUploading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append('model_file', modelFile);
      form.append('config_file', configFile);
      form.append('display_name', displayName);
      form.append('description', description);

      const r = await fetch(`${API}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || `Upload failed (${r.status})`);
      }
      onUploaded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 rounded-2xl border border-border/30 bg-card shadow-m3 p-6 space-y-5 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold tracking-tight">Upload Piper Voice</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-card/80 text-muted-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
              Display Name
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Warm British Female"
              className="w-full bg-background border border-border/40 rounded-xl p-3 text-sm font-medium focus:outline-none focus:border-primary/50"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
              Description
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. A warm, conversational British English voice"
              className="w-full bg-background border border-border/40 rounded-xl p-3 text-sm font-medium focus:outline-none focus:border-primary/50"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FileDropZone
              label="Model File"
              accept=".onnx"
              hint=".onnx"
              file={modelFile}
              onFile={setModelFile}
            />
            <FileDropZone
              label="Config File"
              accept=".onnx.json,.json"
              hint=".onnx.json"
              file={configFile}
              onFile={setConfigFile}
            />
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-400/5 border border-red-400/20 rounded-xl p-3">{error}</p>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-bold text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleUpload()}
            disabled={!modelFile || !configFile || uploading}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-bold shadow-m2 hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {uploading ? (
              <><Loader2 size={14} className="animate-spin" /> Uploading...</>
            ) : (
              <><Upload size={14} /> Upload Voice</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── File Drop Zone ──────────────────────────────────────────────

const FileDropZone: React.FC<{
  label: string;
  accept: string;
  hint: string;
  file: File | null;
  onFile: (f: File | null) => void;
}> = ({ label, accept, hint, file, onFile }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div className="space-y-2">
      <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
        {label}
      </label>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
          dragOver
            ? 'border-primary/50 bg-primary/5'
            : file
              ? 'border-emerald-400/30 bg-emerald-400/5'
              : 'border-border/30 bg-background/30 hover:border-border/50'
        }`}
      >
        {file ? (
          <div className="space-y-1">
            <div className="text-xs font-bold text-emerald-400 truncate">{file.name}</div>
            <div className="text-[10px] text-muted-foreground">{formatBytes(file.size)}</div>
            <button
              onClick={(e) => { e.stopPropagation(); onFile(null); }}
              className="text-[10px] text-red-400 hover:underline"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            <Upload size={20} className="mx-auto text-muted-foreground" />
            <div className="text-xs text-muted-foreground">
              Drop {hint} here or click to browse
            </div>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
        />
      </div>
    </div>
  );
};

export default VoicesSection;
