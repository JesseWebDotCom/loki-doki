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
    <div className="flex flex-col items-start gap-4">
      <div className="flex gap-1.5 px-0.5 opacity-40">
        <div className="h-1.5 w-1.5 rounded-full bg-[#ececec] animate-pulse" />
        <div className="h-1.5 w-1.5 rounded-full bg-[#ececec] animate-pulse" style={{ animationDelay: "200ms" }} />
        <div className="h-1.5 w-1.5 rounded-full bg-[#ececec] animate-pulse" style={{ animationDelay: "400ms" }} />
      </div>
      <div className="text-[11px] font-medium tracking-widest text-[#8e8e8e]/40 uppercase">
        {seconds}s elapsed
      </div>
    </div>
  )
}
