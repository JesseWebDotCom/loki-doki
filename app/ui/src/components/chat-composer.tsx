import { type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react"
import { ArrowUp, Clapperboard, FileText, ImagePlus, Mic, MicOff, Plus, Square, ChevronDown, Check, Settings2, History } from "lucide-react"

import { ChatAudioVisualizer } from "@/components/chat-audio-visualizer"
import { ChatFilePreview } from "@/components/chat-file-preview"
import { WakewordSignalVisualizer } from "@/components/wakeword-signal-visualizer"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { type PendingDocument, type PendingImage, type PendingVideo } from "@/media"

type ChatComposerProps = {
  userReady: boolean
  isSubmitting: boolean
  isCharacterSyncPending: boolean
  prompt: string
  selectedImage: PendingImage | null
  selectedVideo: PendingVideo | null
  selectedDocument: PendingDocument | null
  isAttachmentMenuOpen: boolean
  isVoiceListening: boolean
  voiceStatus: string
  characterSyncLabel: string
  voiceReplyEnabled: boolean
  isVoiceReplyPending: boolean
  voiceSource: "browser" | "piper"
  selectedPiperVoiceLabel: string
  wakewordEnabled: boolean
  isWakewordMonitoring: boolean
  wakewordSignalLevel: number
  wakewordSpeechLevel: number
  wakewordScore: number
  recordingStream: MediaStream | null
  characterName: string
  imageInputRef: RefObject<HTMLInputElement | null>
  videoInputRef: RefObject<HTMLInputElement | null>
  documentInputRef: RefObject<HTMLInputElement | null>
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onPromptChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onToggleAttachmentMenu: () => void
  onTogglePushToTalk: () => void
  onRemoveImage: () => void
  onRemoveVideo: () => void
  onRemoveDocument: () => void
  onImageSelected: (event: ChangeEvent<HTMLInputElement>) => void
  onVideoSelected: (event: ChangeEvent<HTMLInputElement>) => void
  onDocumentSelected: (event: ChangeEvent<HTMLInputElement>) => void
  onCloseAttachmentMenu: () => void
  chatError: string
  performanceProfileId?: string
  isProfileMenuOpen?: boolean
  onToggleProfileMenu?: () => void
  onSelectProfile?: (id: string) => void
  onCloseProfileMenu?: () => void
}

export type PerformanceProfile = {
  id: string
  name: string
  subtitle: string
}

export const defaultPerformanceProfiles: PerformanceProfile[] = [
  { id: "fast", name: "Fast", subtitle: "Answers quickly" },
  { id: "thinking", name: "Thinking", subtitle: "Solves complex problems" },
  { id: "pro", name: "Pro", subtitle: "Advanced math and code with 3.1 Pro" },
]

export function ChatComposer({
  userReady,
  isSubmitting,
  isCharacterSyncPending,
  prompt,
  selectedImage,
  selectedVideo,
  selectedDocument,
  isAttachmentMenuOpen,
  isVoiceListening,
  voiceStatus,
  characterSyncLabel,
  voiceReplyEnabled,
  isVoiceReplyPending,
  voiceSource,
  selectedPiperVoiceLabel,
  wakewordEnabled,
  isWakewordMonitoring,
  wakewordSignalLevel,
  wakewordSpeechLevel,
  wakewordScore,
  recordingStream,
  characterName,
  imageInputRef,
  videoInputRef,
  documentInputRef,
  onSubmit,
  onPromptChange,
  onPromptKeyDown,
  onToggleAttachmentMenu,
  onTogglePushToTalk,
  onRemoveImage,
  onRemoveVideo,
  onRemoveDocument,
  onImageSelected,
  onVideoSelected,
  onDocumentSelected,
  onCloseAttachmentMenu,
  chatError,
  performanceProfileId = "fast",
  isProfileMenuOpen = false,
  onToggleProfileMenu = () => {},
  onSelectProfile = () => {},
  onCloseProfileMenu = () => {},
}: ChatComposerProps) {
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)

  const [internalProfileId, setInternalProfileId] = useState(performanceProfileId)
  const [internalMenuOpen, setInternalMenuOpen] = useState(isProfileMenuOpen)

  const activeProfileId = internalProfileId || performanceProfileId
  const menuOpen = internalMenuOpen || isProfileMenuOpen
  const activeProfile = defaultPerformanceProfiles.find(p => p.id === activeProfileId) || defaultPerformanceProfiles[0]

  useEffect(() => { setInternalProfileId(performanceProfileId) }, [performanceProfileId])
  useEffect(() => { setInternalMenuOpen(isProfileMenuOpen) }, [isProfileMenuOpen])

  const handleToggleProfileMenu = () => {
    setInternalMenuOpen(!menuOpen)
    onToggleProfileMenu()
  }

  const handleSelectProfile = (id: string) => {
    setInternalProfileId(id)
    onSelectProfile(id)
  }

  const handleCloseProfileMenu = useCallback(() => {
    setInternalMenuOpen(false)
    onCloseProfileMenu()
  }, [onCloseProfileMenu])

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (isAttachmentMenuOpen && attachmentMenuRef.current && !attachmentMenuRef.current.contains(event.target as Node)) {
        onCloseAttachmentMenu()
      }
      if (menuOpen && profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        handleCloseProfileMenu()
      }
    }
    window.addEventListener("mousedown", handlePointerDown)
    return () => window.removeEventListener("mousedown", handlePointerDown)
  }, [isAttachmentMenuOpen, menuOpen, onCloseAttachmentMenu, handleCloseProfileMenu])

  const placeholder = `How can I help you today?`

  return (
    <div className="relative z-50 mx-auto w-full max-w-[1100px] px-4 pb-4 md:px-8 md:pb-8">
      <div className="w-full">
        {/* Media Previews */}
        {(selectedImage || selectedVideo || selectedDocument) && (
          <div className="mb-4 flex flex-wrap gap-2 px-4">
             {selectedImage && <ChatFilePreview kind="image" name={selectedImage.name} onRemove={onRemoveImage} previewUrl={selectedImage.dataUrl} />}
             {selectedVideo && <ChatFilePreview kind="video" name={selectedVideo.name} meta={`${selectedVideo.frameDataUrls.length} frames`} onRemove={onRemoveVideo} previewUrl={selectedVideo.posterDataUrl} />}
             {selectedDocument && <ChatFilePreview kind="document" name={selectedDocument.name} meta={`${selectedDocument.text.length} chars`} onRemove={onRemoveDocument} previewText={selectedDocument.text.slice(0, 60)} />}
          </div>
        )}

        <div className="chat-composer-pill flex flex-col gap-0 overflow-hidden shadow-2xl transition-all focus-within:ring-1 focus-within:ring-white/10">
          <form className="flex items-end gap-1 p-2 pl-3" onSubmit={onSubmit}>
            {/* Left Controls: Attachments & Settings */}
            <div className="flex shrink-0 items-center gap-0.5 pb-0.5">
               <div className="relative" ref={attachmentMenuRef}>
                  <Button
                    className="h-9 w-9 rounded-full text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]"
                    disabled={!userReady || isSubmitting || isCharacterSyncPending}
                    onClick={onToggleAttachmentMenu}
                    type="button"
                    variant="ghost"
                    size="icon"
                  >
                    <Plus className="h-[20px] w-[20px]" />
                  </Button>
                  {isAttachmentMenuOpen && (
                    <div className="absolute bottom-[calc(100%+12px)] left-0 z-50 w-56 rounded-xl border border-[#1a1a1a] bg-[#161616] p-1.5 shadow-2xl">
                      <MenuButton icon={<ImagePlus className="h-4 w-4" />} label="Image" onClick={() => { onCloseAttachmentMenu(); imageInputRef.current?.click() }} />
                      <MenuButton icon={<Clapperboard className="h-4 w-4" />} label="Video" onClick={() => { onCloseAttachmentMenu(); videoInputRef.current?.click() }} />
                      <MenuButton icon={<FileText className="h-4 w-4" />} label="Document" onClick={() => { onCloseAttachmentMenu(); documentInputRef.current?.click() }} />
                    </div>
                  )}
               </div>
               <Button className="h-9 w-9 rounded-full text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" variant="ghost" size="icon">
                 <Settings2 className="h-[18px] w-[18px]" />
               </Button>
               <Button className="h-9 w-9 rounded-full text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" variant="ghost" size="icon">
                 <History className="h-[18px] w-[18px]" />
               </Button>
            </div>

            {/* Main Input Area */}
            <div className="min-w-0 flex-1 px-1">
              <input ref={imageInputRef} accept="image/*" className="hidden" onChange={onImageSelected} type="file" />
              <input ref={videoInputRef} accept="video/*" className="hidden" onChange={onVideoSelected} type="file" />
              <input ref={documentInputRef} accept=".txt,.md,.markdown" className="hidden" onChange={onDocumentSelected} type="file" />
              <Textarea
                autoCapitalize="sentences"
                className="max-h-[200px] min-h-[42px] w-full resize-none border-0 bg-transparent py-2.5 text-[15px] leading-relaxed text-[#ececec] placeholder:text-[#666] focus-visible:ring-0"
                disabled={isCharacterSyncPending}
                onChange={onPromptChange}
                onKeyDown={onPromptKeyDown}
                placeholder={placeholder}
                value={prompt}
              />
            </div>

            {/* Right Controls: Model Selector, Mic, Send */}
            <div className="flex shrink-0 items-center gap-1.5 pb-0.5 pr-1">
              <div className="relative" ref={profileMenuRef}>
                <button
                  className="flex h-9 items-center gap-2 rounded-lg bg-white/[0.03] px-3 text-[12px] font-semibold text-[#8e8e8e] transition hover:bg-white/[0.06] hover:text-[#ececec]"
                  onClick={handleToggleProfileMenu}
                  type="button"
                >
                  <img src="/lokidoki-logo.svg" className="h-3.5 w-3.5 opacity-60 grayscale" alt="" />
                  <span>{activeProfile.name}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </button>
                {menuOpen && (
                  <div className="absolute bottom-[calc(100%+12px)] right-0 z-50 w-64 rounded-xl border border-[#1a1a1a] bg-[#161616] p-1.5 shadow-2xl">
                    {defaultPerformanceProfiles.map((p) => (
                      <ProfileMenuButton key={p.id} isSelected={p.id === activeProfileId} name={p.name} subtitle={p.subtitle} onClick={() => { handleSelectProfile(p.id); handleCloseProfileMenu() }} />
                    ))}
                  </div>
                )}
              </div>

              <Button
                className={`h-9 w-9 rounded-full transition-colors ${isVoiceListening ? "bg-white text-black" : "text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]"}`}
                onClick={onTogglePushToTalk}
                variant="ghost"
                size="icon"
              >
                {isVoiceListening ? <MicOff className="h-[18px] w-[18px]" /> : <Mic className="h-[18px] w-[18px]" />}
              </Button>

              <Button
                className={`h-9 w-9 rounded-full bg-[#333] text-white transition hover:bg-[#444] disabled:opacity-30 ${isSubmitting ? "animate-pulse" : ""}`}
                disabled={!userReady || isSubmitting || isCharacterSyncPending || (!prompt.trim() && !selectedImage && !selectedVideo && !selectedDocument)}
                type="submit"
                size="icon"
              >
                {isSubmitting ? <Square className="h-3.5 w-3.5 fill-current" /> : <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />}
              </Button>
            </div>
          </form>

          {/* Voice Visualizer Strip */}
          {isVoiceListening && (
            <div className="border-t border-[#1a1a1a] bg-black/20 p-3">
              <ChatAudioVisualizer isRecording={isVoiceListening} onClick={onTogglePushToTalk} stream={recordingStream} />
            </div>
          )}
        </div>
        
        {/* Status and Error indicators */}
        <div className="mt-3 flex items-center justify-between px-4 text-[11px] text-[#8e8e8e]/60">
           <div>{voiceStatus || (isSubmitting ? "Running..." : "")}</div>
           {chatError && <div className="text-rose-400">{chatError}</div>}
        </div>
      </div>
    </div>
  )
}

function MenuButton({ icon, label, onClick }: { icon: ReactNode, label: string, onClick: () => void }) {
  return (
    <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-[#ececec] transition hover:bg-white/[0.05]" onClick={onClick} type="button">
      <span className="text-[#8e8e8e]">{icon}</span>
      {label}
    </button>
  )
}

function ProfileMenuButton({ name, subtitle, isSelected, onClick }: { name: string, subtitle: string, isSelected: boolean, onClick: () => void }) {
  return (
    <button className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-white/[0.05] ${isSelected ? "bg-white/[0.03]" : ""}`} onClick={onClick} type="button">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[#ececec]">{name}</div>
        <div className="truncate text-[11px] text-[#8e8e8e]">{subtitle}</div>
      </div>
      {isSelected && <Check className="h-3.5 w-3.5 text-[#ececec]" strokeWidth={3} />}
    </button>
  )
}

