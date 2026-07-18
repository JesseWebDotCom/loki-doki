// Keep the sound going when an iPhone screen locks or the user switches apps while a
// VIDEO is playing in the PWA. iOS pauses a backgrounded <video> element (by design);
// the fix - same trick FileTube uses - is to hand playback to a hidden <audio> element
// streaming an audio-only rendition at the same position, then hand back on return.
//
// Interplay with PiP: if the video actually entered Picture-in-Picture (auto-PiP on an
// app switch), it keeps playing on its own - we wait a beat after hiding and only swap
// when no PiP engaged (a locked screen never has PiP, so lock always swaps).
//
// The audio src is resolved lazily but PREWARMED on first play (a hidden page gets very
// little JS time on iOS, so the URL must already be known by the time we need it).

import { useEffect, useRef } from 'react'
import { isIOS } from '@/lib/platform'

function inPictureInPicture(el: HTMLVideoElement): boolean {
  if (document.pictureInPictureElement === el) return true
  const mode = (el as HTMLVideoElement & { webkitPresentationMode?: string }).webkitPresentationMode
  return mode === 'picture-in-picture'
}

export function useBackgroundAudio(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  opts: {
    /** Audio-only URL for the current item; called once per item on first play (may
     *  trigger a server-side extraction and resolve null until it's ready). */
    getAudioSrc: () => Promise<string | null> | string | null
    enabled?: boolean
  },
): void {
  const { getAudioSrc, enabled = true } = opts
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const warmedRef = useRef<Promise<string | null> | null>(null)
  const swappedRef = useRef(false)
  const getSrcRef = useRef(opts.getAudioSrc)
  getSrcRef.current = getAudioSrc

  useEffect(() => {
    warmedRef.current = null   // new getAudioSrc identity = new item
  }, [getAudioSrc])

  useEffect(() => {
    if (!enabled || !isIOS()) return
    // The <video> mounts lazily; listen at document level (capture - media events
    // don't bubble) and read videoRef.current at event time.

    const warm = (e?: Event) => {
      if (e && e.target !== videoRef.current) return
      if (!warmedRef.current) warmedRef.current = Promise.resolve(getSrcRef.current()).catch(() => null)
    }

    const swapToAudio = async () => {
      const el = videoRef.current
      if (!el || el.paused || swappedRef.current) return
      warm()
      const src = await warmedRef.current
      if (!src || document.visibilityState !== 'hidden') return
      const el2 = videoRef.current
      if (!el2 || el2.paused || inPictureInPicture(el2)) return
      const audio = (audioRef.current ??= new Audio())
      audio.src = src
      audio.currentTime = el2.currentTime
      try {
        await audio.play()
        swappedRef.current = true
        el2.pause()
      } catch {
        audio.removeAttribute('src')
      }
    }

    const swapBack = () => {
      const audio = audioRef.current
      const el = videoRef.current
      if (!swappedRef.current || !audio || !el) return
      swappedRef.current = false
      el.currentTime = audio.currentTime
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      void el.play().catch(() => {})
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // Give native auto-PiP ~400 ms to claim the video first (app switch); a locked
        // screen never PiPs, so the swap proceeds there.
        setTimeout(() => { if (document.visibilityState === 'hidden') void swapToAudio() }, 400)
      } else {
        swapBack()
      }
    }

    document.addEventListener('playing', warm, true)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('playing', warm, true)
      document.removeEventListener('visibilitychange', onVisibility)
      swappedRef.current = false
      audioRef.current?.pause()
      audioRef.current?.removeAttribute('src')
    }
  }, [videoRef, enabled])
}
