import { Card } from '@/components/ui/card'
import type { JokeBlockData } from './types'

export function JokeCard({ data }: { data: JokeBlockData }) {
  return (
    <Card variant="surface" className="px-4 py-3 text-sm">
      <p className="text-lg mb-1">😄</p>
      <p className="text-[13px] leading-relaxed italic text-card-foreground/90">"{data.joke}"</p>
    </Card>
  )
}
