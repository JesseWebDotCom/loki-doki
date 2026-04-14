import React from 'react';
import { Play, ExternalLink } from 'lucide-react';

interface YouTubePlayerProps {
  videoId: string;
  title?: string;
  channel?: string;
  score?: number;
  videoType?: string;
  /** When rendered inside another card (e.g. channel card), drop outer chrome. */
  embedded?: boolean;
}

const YouTubePlayer: React.FC<YouTubePlayerProps> = ({
  videoId,
  title,
  channel,
  score,
  videoType,
  embedded = false,
}) => {
  if (!videoId) return null;

  const isOfficial = videoType === 'official' || (score ?? 0) > 0.9;
  const wrapperClass = embedded
    ? 'w-full overflow-hidden rounded-xl border border-border/30 bg-card'
    : 'my-3 w-full max-w-md overflow-hidden rounded-2xl border border-border/40 bg-card shadow-m2';

  return (
    <div className={wrapperClass}>
      <div className="flex items-center justify-between gap-2 bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-600/10 text-red-500">
            <Play size={10} fill="currentColor" />
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground truncate">
              {channel || 'YouTube'}
              {isOfficial && (
                <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-px text-[8px] font-bold text-primary border border-primary/20 normal-case tracking-normal">
                  OFFICIAL
                </span>
              )}
            </span>
            {title && (
              <span className="text-[11px] font-semibold text-foreground/90 truncate pr-2">
                {title}
              </span>
            )}
          </div>
        </div>
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on YouTube"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
        >
          <ExternalLink size={12} />
        </a>
      </div>

      <div className="relative aspect-video w-full bg-black">
        <iframe
          src={`https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1`}
          title={title || 'YouTube video'}
          className="absolute inset-0 h-full w-full border-0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    </div>
  );
};

export default YouTubePlayer;
