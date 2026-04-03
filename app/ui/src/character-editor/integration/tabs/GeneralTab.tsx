import React, { useState } from 'react';
import { BrainCircuit, CircleHelp, Fingerprint, Globe, Languages, Loader2, MessageSquareQuote, Siren, Volume2 } from 'lucide-react';
import { Input } from "@/character-editor/components/ui/input";
import { Button } from "@/character-editor/components/ui/button";
import { useVoice } from '@/character-editor/context/VoiceContext';
import VoiceModelControl from '@/character-editor/components/VoiceModelControl';
import WakewordModelControl from '@/character-editor/components/WakewordModelControl';
import { deriveCharacterId } from '@/character-editor/integration/packageManifest';
import { API_BASE_URL, buildAuthHeaders } from '@/character-editor/config';

type AuthMePayload = {
  user?: {
    id?: string;
  };
};

type PromptLabResponse = {
  response?: {
    text?: string;
  };
};

async function generateVoicePreviewLine(options: any): Promise<string> {
  const authResponse = await fetch(`${API_BASE_URL}/api/auth/me`, {
    cache: 'no-store',
    headers: buildAuthHeaders(),
  });
  if (!authResponse.ok) {
    throw new Error('Could not resolve the current user for voice preview.');
  }
  const authPayload = (await authResponse.json()) as AuthMePayload;
  const userId = String(authPayload.user?.id || '').trim();
  if (!userId) {
    throw new Error('Current user id is unavailable for voice preview.');
  }

  const name = String(options.name || 'this character').trim() || 'this character';
  const prompt = String(options.persona_prompt || '').trim();
  const promptLabResponse = await fetch(`${API_BASE_URL}/api/admin/prompt-lab`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(),
    },
    body: JSON.stringify({
      user_id: userId,
      message: `Introduce yourself as ${name} in one short sentence so I can preview your voice. Stay fully in character.`,
      use_skills: false,
      layer_overrides: prompt ? { character_prompt: prompt } : {},
    }),
  });
  if (!promptLabResponse.ok) {
    const errorPayload = await promptLabResponse.json().catch(() => ({}));
    throw new Error(String((errorPayload as { detail?: string }).detail || 'Voice preview generation failed.'));
  }
  const promptPayload = (await promptLabResponse.json()) as PromptLabResponse;
  const previewText = String(promptPayload.response?.text || '').trim();
  if (!previewText) {
    throw new Error('Voice preview generation returned an empty response.');
  }
  return previewText;
}

export const GeneralTab: React.FC<{ options: any; updateOption: (k: any, v: any) => void }> = ({ options, updateOption }) => {
  const { speak, isSpeaking, stop } = useVoice();
  const [isGeneratingVoicePreview, setIsGeneratingVoicePreview] = useState(false);
  const generatedCharacterId = deriveCharacterId(options);

  async function handleVoicePreview() {
    if (!options.voice_model || isSpeaking || isGeneratingVoicePreview) {
      return;
    }
    setIsGeneratingVoicePreview(true);
    try {
      const previewText = await generateVoicePreviewLine(options);
      speak(previewText, options.voice_model);
    } catch (error) {
      console.error('Failed to generate character voice preview:', error);
    } finally {
      setIsGeneratingVoicePreview(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
           <label className="text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>Character Name</label>
           <Input value={options.name || ''} onChange={(e) => updateOption('name', e.target.value)} className="h-10 border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] text-[var(--app-text)]" />
        </div>
        <div className="space-y-2">
           <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
             <Languages className="h-3.5 w-3.5" /> Phonetic Spelling
           </label>
           <Input value={options.phonetic_spelling || ''} onChange={(e) => updateOption('phonetic_spelling', e.target.value)} placeholder="e.g. LOH-kee DOH-kee" className="h-10 border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] text-[var(--app-text)]" />
        </div>
        <div className="space-y-2 md:col-span-2">
           <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
             <Fingerprint className="h-3.5 w-3.5" /> Domain
             <CircleHelp className="h-3.5 w-3.5 text-[var(--app-text-muted)]" title="Domain is the character area or franchise bucket, like lokidoki, southpark, or theterminator." />
           </label>
           <Input
             value={options.identity_key || ''}
             onChange={(e) => updateOption('identity_key', e.target.value)}
             placeholder="Character area, e.g. lokidoki"
             className="h-10 border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] text-[var(--app-text)]"
           />
        </div>
        <div className="space-y-2 md:col-span-2">
           <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
             <Fingerprint className="h-3.5 w-3.5" /> Character ID
             <CircleHelp className="h-3.5 w-3.5 text-[var(--app-text-muted)]" title="Character ID is auto-generated from the character name and domain. It uniquely identifies the character package." />
           </label>
           <Input
             value={generatedCharacterId}
             readOnly
             className="h-10 border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text-muted)]"
           />
        </div>
        <div className="space-y-2 md:col-span-2">
           <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
             <MessageSquareQuote className="h-3.5 w-3.5" /> Teaser
           </label>
           <Input
             value={options.teaser || ''}
             onChange={(e) => updateOption('teaser', e.target.value)}
             placeholder="Short subtitle shown in character dropdowns."
             className="h-10 border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] text-[var(--app-text)]"
           />
        </div>
        <div className="space-y-2 md:col-span-2">
           <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
             <Globe className="h-3.5 w-3.5" /> Description
           </label>
           <textarea
             value={options.description || ''}
             onChange={(e) => updateOption('description', e.target.value)}
             placeholder="Short description shown in the app and catalog."
             className="min-h-24 w-full resize-y rounded-xl border border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] p-3 text-sm text-[var(--app-text)] outline-none"
           />
        </div>
        <div className="space-y-2 md:col-span-2">
           <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
             <BrainCircuit className="h-3.5 w-3.5" /> Prompt
           </label>
           <textarea
             value={options.persona_prompt || ''}
             onChange={(e) => updateOption('persona_prompt', e.target.value)}
             placeholder="Character system prompt"
             className="min-h-40 w-full resize-y rounded-xl border border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] p-3 text-sm text-[var(--app-text)] outline-none"
           />
        </div>
        <div className="space-y-2 md:col-span-2">
           <div className="flex items-center justify-between gap-3">
             <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
               <Volume2 className="h-3.5 w-3.5" /> Voice
             </label>
             <div className="flex items-center gap-2">
               <Button
                 type="button"
                 variant="outline"
                 onClick={() => void handleVoicePreview()}
                 disabled={!options.voice_model || isSpeaking || isGeneratingVoicePreview}
                 className="h-9 rounded-xl border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text)] hover:bg-[color:var(--app-accent-soft)] disabled:bg-[color:var(--app-bg-panel-strong)] disabled:text-[var(--app-text-muted)] disabled:opacity-100"
                 title="Generate a short in-character line from the current prompt, then speak it with the selected voice."
               >
                 {isGeneratingVoicePreview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                 {isGeneratingVoicePreview ? 'Thinking...' : 'Test Voice'}
               </Button>
               <Button
                 type="button"
                 variant="outline"
                 onClick={stop}
                 className="h-9 rounded-xl border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text)] hover:bg-[color:var(--app-accent-soft)]"
               >
                 Stop
               </Button>
             </div>
           </div>
           <VoiceModelControl options={options} updateOption={updateOption} />
        </div>
        <div className="space-y-2 md:col-span-2">
           <label className="flex items-center gap-2 text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
             <Siren className="h-3.5 w-3.5" /> Wakeword
           </label>
           <WakewordModelControl options={options} updateOption={updateOption} />
        </div>
      </div>
    </div>
  );
};
