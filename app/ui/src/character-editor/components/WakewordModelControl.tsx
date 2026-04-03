import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCcw, UploadCloud } from 'lucide-react';

import { Button } from '@/character-editor/components/ui/button';
import { Input } from '@/character-editor/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/character-editor/components/ui/select';
import { API_BASE_URL, buildAuthHeaders } from '@/character-editor/config';
import type { CharacterOptions } from '@/character-editor/context/CharacterContext';

type WakewordSource = {
  id?: string;
  label?: string;
  installed?: boolean;
  phrases?: string[];
};

interface WakewordModelControlProps {
  options: CharacterOptions;
  updateOption: <K extends keyof CharacterOptions>(key: K, value: CharacterOptions[K]) => void;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function slugifyWakewordId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom_wakeword';
}

export default function WakewordModelControl({ options, updateOption }: WakewordModelControlProps) {
  const [sources, setSources] = useState<Array<{ id: string; label: string; phrases: string[] }>>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [modelFile, setModelFile] = useState<File | null>(null);

  const refreshSources = async () => {
    setStatus('loading');
    setMessage('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/wakeword`, {
        headers: buildAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error(`Failed to load wakeword models (${response.status})`);
      }
      const data = await response.json();
      const nextSources = Array.isArray(data?.sources) ? data.sources : [];
      setSources(
        nextSources
          .filter((item: WakewordSource) => Boolean(item?.id))
          .map((item: WakewordSource) => ({
            id: String(item.id),
            label: String(item.label || item.id || 'Wakeword'),
            phrases: Array.isArray(item.phrases) ? item.phrases.filter((entry): entry is string => typeof entry === 'string') : [],
          }))
      );
      setStatus('idle');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Failed to load wakeword models.');
    }
  };

  useEffect(() => {
    void refreshSources();
  }, []);

  const wakewordOptions = useMemo(() => {
    const next = [...sources];
    const currentValue = (options.wakeword_model_id || '').trim();
    if (currentValue && !next.some((source) => source.id === currentValue)) {
      next.unshift({
        id: currentValue,
        label: `${currentValue} (current)`,
        phrases: [],
      });
    }
    return next;
  }, [options.wakeword_model_id, sources]);

  const clearCustomUpload = () => {
    updateOption('wakeword_source_name', '');
    updateOption('wakeword_upload_data_url', '');
  };

  const handleWakewordSelect = (value: string | null) => {
    if (!value) {
      return;
    }
    updateOption('wakeword_model_id', value);
    clearCustomUpload();
    setModelFile(null);
    setMessage('');
  };

  const handleUpload = async () => {
    if (!modelFile) {
      setMessage('Choose one wakeword .onnx model file.');
      return;
    }
    setUploading(true);
    setMessage('');
    try {
      const modelDataUrl = await readFileAsDataUrl(modelFile);
      updateOption('wakeword_model_id', slugifyWakewordId(modelFile.name.replace(/\.onnx$/i, '')));
      updateOption('wakeword_source_name', modelFile.name);
      updateOption('wakeword_upload_data_url', modelDataUrl);
      setModelFile(null);
      setMessage(`Attached ${modelFile.name} and bundled it with the character.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to upload the wakeword model.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={options.wakeword_model_id || ''} onValueChange={handleWakewordSelect}>
          <SelectTrigger className="h-10 border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-sm font-semibold text-[var(--app-accent)]">
            <SelectValue placeholder={status === 'loading' ? 'Loading wakewords...' : 'Select Wakeword'} />
          </SelectTrigger>
          <SelectContent className="border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text)]">
            {wakewordOptions.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                <div className="flex flex-col items-start gap-0.5">
                  <span>{source.label}</span>
                  {source.phrases.length ? (
                    <span className="text-[11px] text-[var(--app-text-muted)]">{source.phrases.join(', ')}</span>
                  ) : null}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-10 w-10 border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[var(--app-text-muted)] hover:bg-[color:var(--app-accent-soft)] hover:text-[var(--app-text)]"
          onClick={() => void refreshSources()}
        >
          {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
        </Button>
      </div>

      <div className="space-y-3 rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-3">
        <label className="space-y-1 text-xs text-[var(--app-text-muted)]">
          <span className="block font-medium uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: 'var(--app-label-letter-spacing)' }}>Custom Wakeword Model</span>
          <Input
            type="file"
            accept=".onnx"
            className="cursor-pointer border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-xs text-[var(--app-text)]"
            onChange={(event) => setModelFile(event.target.files?.[0] || null)}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void handleUpload()}
            disabled={uploading || !modelFile}
            className="border-none bg-[var(--app-accent)] !text-white hover:bg-[var(--app-accent-strong)] disabled:bg-[color:var(--app-bg-panel-strong)] disabled:!text-[var(--app-text-muted)] disabled:opacity-100"
          >
            {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
            Bundle Custom Wakeword
          </Button>
          <div className="text-xs text-[var(--app-text-muted)]">
            Pick a preinstalled wakeword above, or bundle your own `.onnx` model when you save.
          </div>
        </div>

        {message ? (
          <div className={`text-xs ${message.toLowerCase().includes('failed') ? 'text-rose-300' : 'text-[var(--app-text-muted)]'}`}>
            {message}
          </div>
        ) : null}
      </div>
    </div>
  );
}
