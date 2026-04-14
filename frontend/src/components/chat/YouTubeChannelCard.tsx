import React from 'react';
import { Play, ExternalLink } from 'lucide-react';
import YouTubePlayer from './YouTubePlayer';

interface YouTubeChannelCardProps {
  channelName: string;
  handle?: string;
  channelUrl: string;
  avatarUrl?: string;
  featuredVideoId?: string;
}

const YouTubeChannelCard: React.FC<YouTubeChannelCardProps> = ({
  channelName,
  handle,
  channelUrl,
  avatarUrl,
  featuredVideoId,
}) => {
  // When a featured video is present, skip the redundant channel header
  // row — the embedded player already shows the channel name in its
  // chrome, and a dedicated YouTubePlayer is what the user wants to see.
  if (featuredVideoId) {
    return (
      <YouTubePlayer
        videoId={featuredVideoId}
        channel={channelName}
        videoType="featured"
      />
    );
  }

  const cleanHandle = handle ? handle.replace(/^@/, '') : '';

  return (
    <div className="my-3 w-full max-w-md overflow-hidden rounded-2xl border border-border/40 bg-card/60 shadow-m2 transition-colors hover:border-primary/20">
      <div className="flex items-center gap-3 p-3">
        <div className="relative shrink-0">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={channelName}
              className="h-10 w-10 rounded-full border border-border/40 object-cover"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground">
              {channelName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 border border-background">
            <Play size={7} fill="currentColor" className="text-white" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate leading-tight">
            {channelName}
          </h3>
          {cleanHandle && (
            <p className="text-[11px] font-mono text-muted-foreground/70 leading-tight truncate">
              @{cleanHandle}
            </p>
          )}
        </div>

        <a
          href={channelUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
        >
          <ExternalLink size={12} />
          <span>Visit</span>
        </a>
      </div>
    </div>
  );
};

export default YouTubeChannelCard;
