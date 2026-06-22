import { useEffect, useState } from 'react'

/** Re-renders the caller on an interval, returning the current epoch ms. Used by
 *  the Time app for live clock / countdown / stopwatch displays. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
