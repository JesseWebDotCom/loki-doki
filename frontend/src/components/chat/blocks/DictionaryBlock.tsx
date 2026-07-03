import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { DictionaryBlockData } from './types'

export function DictionaryBlock({ data }: { data: DictionaryBlockData }) {
  return (
    <Card variant="surface" className="text-sm">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 flex items-baseline gap-3">
        <span className="text-lg font-semibold">{data.word}</span>
        {data.phonetic && (
          <span className="text-sm text-muted-foreground font-mono">{data.phonetic}</span>
        )}
      </div>

      {/* Senses */}
      <div className="divide-y divide-border/30">
        {data.senses.map((sense, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              {sense.partOfSpeech && (
                <Badge variant="secondary" className="text-[10px] italic">
                  {sense.partOfSpeech}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">#{i + 1}</span>
            </div>
            <p className="text-xs leading-relaxed">{sense.definition}</p>
            {sense.example && (
              <p className="mt-1.5 text-[11px] text-muted-foreground italic">
                "{sense.example}"
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}
