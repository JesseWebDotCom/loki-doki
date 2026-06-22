import { Play } from 'lucide-react'
import type { YouTubeBlockData } from './types'

export function YouTubeEmbed({ data }: { data: YouTubeBlockData }) {
  if (!data.videos.length) return null

  return (
    <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
      {data.videos.map(video => (
        <a
          key={video.videoId}
          href={video.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group shrink-0 w-52 rounded-xl border border-border/50 bg-card overflow-hidden hover:border-border transition-colors"
        >
          {/* Thumbnail */}
          <div className="relative w-full aspect-video bg-muted overflow-hidden">
            <img
              src={`https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg`}
              alt={video.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              loading="lazy"
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm group-hover:bg-red-600 transition-colors">
                <Play className="size-4 text-white fill-white ml-0.5" />
              </div>
            </div>
          </div>

          {/* Title */}
          <div className="px-2.5 py-2">
            <p className="text-xs font-medium leading-snug line-clamp-2 text-card-foreground">
              {video.title}
            </p>
          </div>
        </a>
      ))}
    </div>
  )
}
