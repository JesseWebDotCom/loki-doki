import { type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react"
import { ArrowUp, Clapperboard, FileText, ImagePlus, Mic, MicOff, Plus, Square, ChevronDown, Check } from "lucide-react"

import { ChatAudioVisualizer } from "@/components/chat-audio-visualizer"
import { ChatFilePreview } from "@/components/chat-file-preview"
import { WakewordSignalVisualizer } from "@/components/wakeword-signal-visualizer"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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

  // Internal fallback state so the dropdown works without parent wiring
  const [internalProfileId, setInternalProfileId] = useState(performanceProfileId)
  const [internalMenuOpen, setInternalMenuOpen] = useState(isProfileMenuOpen)

  const activeProfileId = internalProfileId || performanceProfileId
  const menuOpen = internalMenuOpen || isProfileMenuOpen

  const activeProfile = defaultPerformanceProfiles.find(p => p.id === activeProfileId) || defaultPerformanceProfiles[0]

  useEffect(() => {
    setInternalProfileId(performanceProfileId)
  }, [performanceProfileId])

  useEffect(() => {
    setInternalMenuOpen(isProfileMenuOpen)
  }, [isProfileMenuOpen])

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
    if (isAttachmentMenuOpen || menuOpen) {
      window.addEventListener("mousedown", handlePointerDown)
    }
    return () => window.removeEventListener("mousedown", handlePointerDown)
  }, [isAttachmentMenuOpen, menuOpen, onCloseAttachmentMenu, handleCloseProfileMenu])

  const placeholder = selectedImage
    ? "Add context for this image (optional)"
    : selectedVideo
      ? "Add context for this video (optional)"
      : selectedDocument
        ? "Ask about this document or leave blank to summarize it"
        : isCharacterSyncPending
          ? "Wait for character compile to finish..."
        : `Ask ${characterName}...`

  const statusLabel = isCharacterSyncPending
    ? characterSyncLabel
    : isSubmitting
    ? "Thinking..."
    : voiceStatus
    ? voiceStatus
    : selectedImage
      ? "Image analysis ready"
      : selectedVideo
        ? "Video analysis ready"
        : selectedDocument
          ? "Document analysis ready"
          : wakewordEnabled && isWakewordMonitoring
            ? "Wakeword standby"
            : voiceReplyEnabled
              ? isVoiceReplyPending
                ? "Playing voice reply..."
                : `Voice reply: ${voiceSource === "browser" ? "browser" : selectedPiperVoiceLabel || "piper"}`
              : "Ready"
  const showStatusLine = Boolean(
    isCharacterSyncPending || isSubmitting || voiceStatus || isVoiceListening || isWakewordMonitoring || isVoiceReplyPending || selectedImage || selectedVideo || selectedDocument || wakewordEnabled
  )
  const isTranscribing = isSubmitting || /transcribing/i.test(statusLabel)
  const showWakewordStrip = Boolean(wakewordEnabled || isWakewordMonitoring || wakewordSignalLevel > 0.01 || wakewordScore > 0.01)

  return (
    <div className="relative bg-[var(--panel)] px-3 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-6 xl:px-10">
      <Card className="chat-composer-card mx-auto max-w-5xl border-[var(--line)] bg-transparent">
        <form className="p-0" onSubmit={onSubmit}>
          <input
            ref={imageInputRef}
            accept="image/*"
            className="hidden"
            onChange={onImageSelected}
            type="file"
          />
          <input
            ref={videoInputRef}
            accept="video/*"
            className="hidden"
            onChange={onVideoSelected}
            type="file"
          />
          <input
            ref={documentInputRef}
            accept=".txt,.md,.markdown,.csv,.json,.log,.html,.htm,.xml,.yaml,.yml,.rst,.ini,.toml,.py,.js,.jsx,.ts,.tsx,.css,.sql"
            className="hidden"
            onChange={onDocumentSelected}
            type="file"
          />
          {selectedImage || selectedVideo || selectedDocument ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {selectedImage ? (
                <ChatFilePreview
                  kind="image"
                  name={selectedImage.name}
                  onRemove={onRemoveImage}
                  previewUrl={selectedImage.dataUrl}
                />
              ) : null}
              {selectedVideo ? (
                <ChatFilePreview
                  kind="video"
                  name={selectedVideo.name}
                  meta={`${selectedVideo.frameDataUrls.length} frames`}
                  onRemove={onRemoveVideo}
                  previewUrl={selectedVideo.posterDataUrl}
                />
              ) : null}
              {selectedDocument ? (
                <ChatFilePreview
                  kind="document"
                  name={selectedDocument.name}
                  meta={`${selectedDocument.text.length.toLocaleString()} chars`}
                  onRemove={onRemoveDocument}
                  previewText={selectedDocument.text.slice(0, 60)}
                />
              ) : null}
            </div>
          ) : null}

          <div className="rounded-[18px] border border-[var(--line)] bg-[var(--input)] px-3 py-2">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Textarea
                  autoCapitalize="sentences"
                  autoComplete="off"
                  autoCorrect="off"
                  className="max-h-24 min-h-[42px] resize-none border-0 bg-transparent px-1 py-2 text-lg leading-6 text-[var(--foreground)] focus:border-transparent"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  disabled={isCharacterSyncPending}
                  onChange={onPromptChange}
                  onKeyDown={onPromptKeyDown}
                  placeholder={placeholder}
                  value={prompt}
                />
              </div>
              <div className="flex shrink-0 items-center gap-2 pb-1">
                <div className="relative" ref={attachmentMenuRef}>
                    <Button
                      aria-expanded={isAttachmentMenuOpen}
                      className="h-11 w-11 rounded-xl border border-[var(--line)] bg-transparent p-0 text-[var(--foreground)] hover:bg-white/[0.04]"
                      disabled={!userReady || isSubmitting || isCharacterSyncPending}
                      onClick={onToggleAttachmentMenu}
                      type="button"
                      variant="ghost"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                    {isAttachmentMenuOpen ? (
                      <div className="absolute bottom-12 left-0 z-20 w-56 rounded-[22px] border border-[var(--line)] bg-[var(--panel-strong)]/98 p-2 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur">
                        <MenuButton
                          icon={<ImagePlus className="h-4 w-4 text-[var(--muted-foreground)]" />}
                          label="Image"
                          onClick={() => {
                            onCloseAttachmentMenu()
                            imageInputRef.current?.click()
                          }}
                        />
                        <MenuButton
                          icon={<Clapperboard className="h-4 w-4 text-[var(--muted-foreground)]" />}
                          label="Video"
                          onClick={() => {
                            onCloseAttachmentMenu()
                            videoInputRef.current?.click()
                          }}
                        />
                        <MenuButton
                          icon={<FileText className="h-4 w-4 text-[var(--muted-foreground)]" />}
                          label="Document"
                          onClick={() => {
                            onCloseAttachmentMenu()
                            documentInputRef.current?.click()
                          }}
                        />
                      </div>
                    ) : null}
                </div>
                <div className="relative" ref={profileMenuRef}>
                    <Button
                      aria-expanded={menuOpen}
                      className="h-10 rounded-full px-4 border-0 bg-white/[0.04] text-[13px] font-medium text-[var(--foreground)] hover:bg-white/[0.08]"
                      disabled={!userReady || isSubmitting || isCharacterSyncPending}
                      onClick={handleToggleProfileMenu}
                      type="button"
                      variant="ghost"
                    >
                      {activeProfile.name}
                      <ChevronDown className="ml-1 h-3.5 w-3.5 text-zinc-400" />
                    </Button>
                    {menuOpen ? (
                      <div className="absolute bottom-12 right-0 z-20 w-72 rounded-[22px] border border-[var(--line)] bg-[var(--card)]/98 p-1 shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur">
                        {defaultPerformanceProfiles.map((p) => (
                          <ProfileMenuButton
                            key={p.id}
                            isSelected={p.id === activeProfileId}
                            name={p.name}
                            subtitle={p.subtitle}
                            onClick={() => {
                              handleSelectProfile(p.id)
                              handleCloseProfileMenu()
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                </div>
                <Button
                  className={
                    isVoiceListening
                      ? "h-11 w-11 rounded-full text-white bg-white/[0.12] hover:bg-white/[0.16]"
                      : "h-11 w-11 rounded-full text-zinc-300 hover:bg-white/[0.04] hover:text-white"
                  }
                  disabled={!userReady || isSubmitting || isCharacterSyncPending}
                  onClick={onTogglePushToTalk}
                  size="icon"
                  tooltip="Push to talk"
                  type="button"
                  variant="ghost"
                >
                  {isVoiceListening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </Button>
                <Button
                  className={`chat-send-button h-11 w-11 rounded-full bg-white text-black shadow-none hover:bg-white/90 ${isSubmitting ? "is-processing" : ""}`}
                  disabled={!userReady || isSubmitting || isCharacterSyncPending || (!prompt.trim() && !selectedImage && !selectedVideo && !selectedDocument)}
                  size="icon"
                  tooltip={isSubmitting ? "Stop response" : "Send message"}
                  type="submit"
                >
                  {isSubmitting ? <Square className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="min-h-[18px] min-w-0 px-1 pt-1 text-[11px] text-[var(--muted-foreground)]">
              {showStatusLine ? (
                <div className="flex items-center gap-2">
                  {isTranscribing ? (
                    <div className="flex items-center -space-x-2 text-[var(--foreground)]">
                      <span className="typing-dot text-base leading-none">.</span>
                      <span className="typing-dot text-base leading-none" style={{ animationDelay: "90ms" }}>.</span>
                      <span className="typing-dot text-base leading-none" style={{ animationDelay: "180ms" }}>.</span>
                    </div>
                  ) : null}
                  <span>{statusLabel}</span>
                </div>
              ) : null}
            </div>
          </div>
          {showWakewordStrip ? (
            <div className="mt-3 rounded-[20px] border border-[var(--line)] bg-white/[0.02] px-3 py-2">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                  {isWakewordMonitoring ? "Wakeword Listening" : "Wakeword Ready"}
                </div>
                <div className="text-[11px] text-[var(--muted-foreground)]">
                  {isWakewordMonitoring ? "Standby active" : "Enabled"}
                </div>
              </div>
              <WakewordSignalVisualizer
                compact
                isActive={wakewordEnabled || isWakewordMonitoring}
                level={wakewordSignalLevel}
                speechLevel={wakewordSpeechLevel}
                wakewordScore={wakewordScore}
                showLegend
              />
            </div>
          ) : null}
          {isVoiceListening ? (
            <div className="mt-3">
              <div className="mb-2 flex items-center justify-center">
                <button
                  className="rounded-full border border-[var(--line)] bg-white/[0.03] px-3 py-1 text-xs text-[var(--muted-foreground)]"
                  onClick={onTogglePushToTalk}
                  type="button"
                >
                  Click to finish recording
                </button>
              </div>
              <div className="h-18 rounded-[24px] border border-[var(--line)] bg-black/30 p-3">
                <ChatAudioVisualizer isRecording={isVoiceListening} onClick={onTogglePushToTalk} stream={recordingStream} />
              </div>
            </div>
          ) : null}
          {chatError ? <p className="px-2 pt-3 text-sm text-rose-300">{chatError}</p> : null}
        </form>
      </Card>
    </div>
  )
}

function MenuButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm text-[var(--foreground)] transition hover:bg-white/[0.06]"
      onClick={onClick}
      type="button"
    >
      {icon}
      <div>
        <div>{label}</div>
      </div>
    </button>
  )
}

function ProfileMenuButton({
  name,
  subtitle,
  isSelected,
  onClick,
}: {
  name: string
  subtitle: string
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`flex w-full items-center justify-between gap-3 rounded-[16px] px-3 py-2.5 text-left transition hover:bg-white/[0.06] ${isSelected ? "bg-white/[0.04]" : ""}`}
      onClick={onClick}
      type="button"
    >
      <div>
        <div className="text-[13px] font-medium text-[var(--foreground)]">{name}</div>
        <div className="text-[11px] text-zinc-500">{subtitle}</div>
      </div>
      {isSelected ? (
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#8ab4f8]">
          <Check className="h-3.5 w-3.5 text-black" strokeWidth={3} />
        </div>
      ) : null}
    </button>
  )
}
