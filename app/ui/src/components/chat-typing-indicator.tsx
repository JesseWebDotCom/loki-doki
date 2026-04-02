import { useEffect, useState } from "react"
import { Dot } from "lucide-react"

export function ChatTypingIndicator() {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((prev) => prev + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex flex-col items-start gap-1 p-1">
      <div className="flex -space-x-2 text-[var(--foreground)] opacity-70">
        <Dot className="typing-dot h-6 w-6" />
        <Dot className="typing-dot h-6 w-6" style={{ animationDelay: "90ms" }} />
        <Dot className="typing-dot h-6 w-6" style={{ animationDelay: "180ms" }} />
      </div>
      <div className="px-1 text-[11px] font-medium tracking-[0.14em] text-[var(--muted-foreground)] uppercase">
        Working for {seconds}s
      </div>
    </div>
  )
}
