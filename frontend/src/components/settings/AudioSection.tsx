import React, { useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, PauseCircle, Play, Save, Volume2 } from "lucide-react";
import { getSettings, saveSettings, type SettingsData } from "../../lib/api";
import { VoiceStreamer } from "../../utils/VoiceStreamer";

interface VoiceOption {
  value: string;
  label: string;
  note: string;
}

const FALLBACK_VOICES: VoiceOption[] = [
  { value: "en_US-lessac-medium", label: "Clear and natural (US)", note: "Balanced default voice" },
];

const LISTENING_OPTIONS = [
  { value: "tiny", label: "Fastest", note: "Quickest response, lowest accuracy" },
  { value: "base", label: "Balanced", note: "Good mix of speed and accuracy" },
  { value: "small", label: "Most accurate", note: "Best recognition, a bit slower" },
];

const TEST_PHRASE =
  "Hi, I'm LokiDoki. This is what I sound like with your current audio settings.";

const AudioSection: React.FC = () => {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>(FALLBACK_VOICES);
  const streamerRef = useRef<VoiceStreamer | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings).catch(() => {});
    // Fetch installed voices to populate the dropdown dynamically.
    void fetch("/api/v1/audio/voices", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.voices?.length) {
          setVoiceOptions(
            data.voices.map((v: { voice_id: string; display_name: string; description: string }) => ({
              value: v.voice_id,
              label: v.display_name,
              note: v.description || v.voice_id,
            })),
          );
        }
      })
      .catch(() => {});
    return () => {
      abortRef.current?.abort();
      streamerRef.current?.stop();
    };
  }, []);

  const stopPreview = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamerRef.current?.stop();
    setIsPreviewing(false);
  };

  const playPreview = async () => {
    if (!settings) return;
    stopPreview();
    setPreviewError(null);
    setIsPreviewing(true);

    const controller = new AbortController();
    abortRef.current = controller;
    if (!streamerRef.current) {
      streamerRef.current = new VoiceStreamer();
    }

    try {
      await streamerRef.current.stream(TEST_PHRASE, {
        signal: controller.signal,
        voiceId: settings.piper_voice,
        speechRate: settings.speech_rate,
        sentencePause: settings.sentence_pause,
        normalizeText: settings.normalize_text,
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setPreviewError((error as Error).message || "Preview failed");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsPreviewing(false);
    }
  };

  const save = async () => {
    if (!settings) return;
    await saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!settings) return null;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                <Volume2 size={12} /> Voice
              </label>
              <select
                value={settings.piper_voice}
                onChange={(e) =>
                  setSettings({ ...settings, piper_voice: e.target.value })
                }
                className="w-full bg-card/50 border border-border/50 rounded-xl p-3 text-sm font-medium focus:outline-none focus:border-primary/50"
              >
                {voiceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} ({option.note})
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Choose how LokiDoki sounds when it speaks.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                <Mic size={12} /> Speech Recognition
              </label>
              <select
                value={settings.stt_model}
                onChange={(e) =>
                  setSettings({ ...settings, stt_model: e.target.value })
                }
                className="w-full bg-card/50 border border-border/50 rounded-xl p-3 text-sm font-medium focus:outline-none focus:border-primary/50"
              >
                {LISTENING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} ({option.note})
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Controls how quickly and accurately LokiDoki turns your voice into text.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-3 p-4 rounded-xl bg-card/50 border border-border/30 cursor-pointer hover:border-border/60 transition-all">
            <input
              type="checkbox"
              checked={settings.read_aloud}
              onChange={(e) =>
                setSettings({ ...settings, read_aloud: e.target.checked })
              }
              className="w-4 h-4 rounded border-border accent-primary"
            />
            <div>
              <div className="text-sm font-bold">Read responses out loud</div>
              <div className="text-xs text-muted-foreground">
                Speak each reply automatically after it appears on screen.
              </div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-4 rounded-xl bg-card/50 border border-border/30 cursor-pointer hover:border-border/60 transition-all">
            <input
              type="checkbox"
              checked={settings.streaming_enabled}
              onChange={(e) =>
                setSettings({ ...settings, streaming_enabled: e.target.checked })
              }
              className="w-4 h-4 rounded border-border accent-primary"
            />
            <div>
              <div className="text-sm font-bold">Start speaking while the reply is still typing</div>
              <div className="text-xs text-muted-foreground">
                Streams voice sentence-by-sentence instead of waiting for the full reply to finish.
              </div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-4 rounded-xl bg-card/50 border border-border/30 cursor-pointer hover:border-border/60 transition-all">
            <input
              type="checkbox"
              checked={settings.normalize_text}
              onChange={(e) =>
                setSettings({ ...settings, normalize_text: e.target.checked })
              }
              className="w-4 h-4 rounded border-border accent-primary"
            />
            <div>
              <div className="text-sm font-bold">Make spoken replies easier to understand</div>
              <div className="text-xs text-muted-foreground">
                Expand dates, numbers, links, and abbreviations before speaking.
              </div>
            </div>
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                Speech Speed
              </label>
              <input
                type="range"
                min="0.8"
                max="1.3"
                step="0.05"
                value={settings.speech_rate}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    speech_rate: Number(e.target.value),
                  })
                }
                className="w-full accent-primary"
              />
              <div className="text-xs text-muted-foreground">
                {settings.speech_rate.toFixed(2)}x speed
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                Pause Between Sentences
              </label>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={settings.sentence_pause}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    sentence_pause: Number(e.target.value),
                  })
                }
                className="w-full accent-primary"
              />
              <div className="text-xs text-muted-foreground">
                {settings.sentence_pause.toFixed(2)}s pause
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-border/30 bg-card/50 p-5 shadow-m1 space-y-4">
          <div className="space-y-1">
            <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Test Voice
            </div>
            <h3 className="text-lg font-bold tracking-tight">Hear it before you save</h3>
            <p className="text-sm text-muted-foreground">
              Plays a short sample using your current voice, speed, pause, and speech cleanup settings.
            </p>
          </div>

          <div className="rounded-xl border border-border/20 bg-background/50 p-4 text-sm text-foreground/85">
            {TEST_PHRASE}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void (isPreviewing ? stopPreview() : playPreview())}
              className="inline-flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-4 py-2.5 text-sm font-bold text-primary transition-colors hover:bg-primary/15"
            >
              {isPreviewing ? (
                <>
                  <PauseCircle size={16} />
                  Stop Preview
                </>
              ) : (
                <>
                  <Play size={16} />
                  Test Voice
                </>
              )}
            </button>
            {isPreviewing && (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                Playing sample…
              </span>
            )}
          </div>

          {previewError && (
            <p className="text-xs text-red-400">{previewError}</p>
          )}
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={() => void save()}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all shadow-m2 ${
            saved
              ? "bg-green-500/20 text-green-400 border border-green-500/30"
              : "bg-primary text-white hover:bg-primary/90 active:scale-95"
          }`}
        >
          {saved ? <Check size={14} /> : <Save size={14} />}
          {saved ? "Saved" : "Save Audio Settings"}
        </button>
      </div>
    </div>
  );
};

export default AudioSection;
