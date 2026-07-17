import { useTogetherPresence } from '@/hooks/useTogetherPresence'

// Listening Together: mount point for the presence heartbeat (the hook needs the
// player contexts, so it lives inside the providers). Mounted once in App.tsx
// beside FamilyAudioGuard; renders nothing.
export function TogetherPresence() {
  useTogetherPresence()
  return null
}
