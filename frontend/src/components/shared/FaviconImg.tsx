import { useState, useEffect } from 'react'
import { getFavicon, getFaviconSync } from '@/lib/faviconCache'

interface FaviconImgProps {
  domain: string
  className?: string
}

export function FaviconImg({ domain, className = 'size-3 rounded-[2px] object-contain' }: FaviconImgProps) {
  const [src, setSrc] = useState<string>(() => getFaviconSync(domain) ?? '')

  useEffect(() => {
    if (!domain) return
    let cancelled = false
    getFavicon(domain).then(url => {
      if (!cancelled) setSrc(url)
    })
    return () => { cancelled = true }
  }, [domain])

  if (!src) return null
  return <img src={src} alt="" className={className} />
}
