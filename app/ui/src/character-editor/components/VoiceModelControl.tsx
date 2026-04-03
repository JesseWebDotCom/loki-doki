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

type VoiceCatalogEntry = {
  id: string;
  label: string;
  has_config: boolean;
  is_custom: boolean;
};

interface VoiceModelControlProps {
  options: CharacterOptions;
  updateOption: <K extends keyof CharacterOptions>(key: K, value: CharacterOptions[K]) => void;
  compact?: boolean;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export default function VoiceModelControl({
  options,
  updateOption,
  compact = false,
}: VoiceModelControlProps) {
  const [voices, setVoices] = useState<VoiceCatalogEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);

  const refreshVoices = async () => {
    setStatus('loading');
    setMessage('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/voices`, {
        headers: buildAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error(`Failed to load installed voices (${response.status})`);
      }
      const data = await response.json();
      setVoices(Array.isArray(data.voices) ? data.voices : []);
      setStatus('idle');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Failed to load installed voices.');
    }
  };

  useEffect(() => {
    void refreshVoices();
  }, []);

  const voiceOptions = useMemo(() => {
    const next = [...voices];
    const currentValue = (options.voice_model || '').trim();
    if (currentValue && !next.some((voice) => voice.id === currentValue)) {
      next.unshift({
        id: currentValue,
        label: `${currentValue} (current)`,
        has_config: true,
        is_custom: true,
      });
    }
    return next;
  }, [options.voice_model, voices]);

  const clearCustomVoiceUpload = () => {
    updateOption('default_voice_source_name', '');
    updateOption('default_voice_config_source_name', '');
    updateOption('default_voice_upload_data_url', '');
    updateOption('default_voice_config_upload_data_url', '');
  };

  const handleVoiceSelect = (value: string | null) => {
    if (!value) {
      return;
    }
    updateOption('voice_model', value);
    clearCustomVoiceUpload();
    setModelFile(null);
    setConfigFile(null);
    setMessage('');
  };

  const handleUpload = async () => {
    if (!modelFile || !configFile) {
      setMessage('Choose both the Piper model (.onnx) and config (.onnx.json) files.');
      return;
    }

    setUploading(true);
    setMessage('');
    try {
      const [modelDataUrl, configDataUrl] = await Promise.all([
        readFileAsDataUrl(modelFile),
        readFileAsDataUrl(configFile),
      ]);

      updateOption('voice_model', modelFile.name);
      updateOption('default_voice_source_name', modelFile.name);
      updateOption('default_voice_config_source_name', configFile.name);
      updateOption('default_voice_upload_data_url', modelDataUrl);
      updateOption('default_voice_config_upload_data_url', configDataUrl);
      setModelFile(null);
      setConfigFile(null);
      setMessage(`Attached ${modelFile.name} and saved it into the character package.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to upload the voice files.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={options.voice_model || ''} onValueChange={handleVoiceSelect}>
          <SelectTrigger
            className={`border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] ${compact ? 'h-8 rounded-lg text-[10px]' : 'h-10 rounded-xl text-sm'} font-semibold text-[var(--app-accent)]`}
          >
            <SelectValue placeholder={status === 'loading' ? 'Loading voices...' : 'Select Voice Model'} />
          </SelectTrigger>
          <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
            {voiceOptions.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                <div className="flex items-center gap-2">
                  <span>{voice.label}</span>
                  {!voice.has_config ? <span className="text-[10px] text-amber-400">No config</span> : null}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={`${compact ? 'h-8 w-8' : 'h-10 w-10'} border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[var(--app-text-muted)] hover:bg-[color:var(--app-accent-soft)] hover:text-[var(--app-text)]`}
          onClick={() => void refreshVoices()}
        >
          {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
        </Button>
      </div>

      <div className={`space-y-3 rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] ${compact ? 'p-2.5' : 'p-3'}`}>
        <div className="grid gap-2 md:grid-cols-2">
          <label className="space-y-1 text-xs text-[var(--app-text-muted)]">
            <span className="block font-medium uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>Piper Model</span>
            <Input
              type="file"
              accept=".onnx"
              className="cursor-pointer border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-xs text-[var(--app-text)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--app-accent)] file:px-2 file:py-1 file:text-xs file:font-semibold file:text-white"
              onChange={(event) => setModelFile(event.target.files?.[0] || null)}
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--app-text-muted)]">
            <span className="block font-medium uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>Piper Config</span>
            <Input
              type="file"
              accept=".json,.onnx.json"
              className="cursor-pointer border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-xs text-[var(--app-text)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--app-accent)] file:px-2 file:py-1 file:text-xs file:font-semibold file:text-white"
              onChange={(event) => setConfigFile(event.target.files?.[0] || null)}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void handleUpload()}
            disabled={uploading || !modelFile || !configFile}
            className="border-none bg-[var(--app-accent)] text-white hover:bg-[var(--app-accent-strong)]"
          >
            {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
            Upload Custom Voice
          </Button>
          <div className="text-xs text-[var(--app-text-muted)]">
            Installed voices come from the voice server. Custom uploads are bundled with the character when you save.
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
