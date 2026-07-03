import { useState } from 'react'
import { categoryVisual } from '@/lib/archiveCategories'

interface Props {
  zimIconUrl: string | null
  category: string
  /** Applied to both the img and the fallback icon; use a size class like "size-3.5" */
  className?: string
}

export function ArchiveIcon({ zimIconUrl, category, className = 'size-3.5' }: Props) {
  const visual = categoryVisual(category)
  const [ok, setOk] = useState(true)
  return zimIconUrl && ok
    ? <img src={zimIconUrl} className={`${className} object-contain`} alt="" onError={() => setOk(false)} />
    : <visual.icon className={`${className} text-white`} />
}
