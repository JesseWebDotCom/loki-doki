import type { JokeBlockData } from './types'

export function JokeCard({ data }: { data: JokeBlockData }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card px-4 py-3 text-sm">
      <p className="text-lg mb-1">😄</p>
      <p className="text-[13px] leading-relaxed italic text-card-foreground/90">"{data.joke}"</p>
    </div>
  )
}
