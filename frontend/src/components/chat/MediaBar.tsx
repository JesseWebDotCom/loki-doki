import React from 'react';
import type { MediaCard } from '../../lib/api';
import YouTubePlayer from './YouTubePlayer';
import YouTubeChannelCard from './YouTubeChannelCard';

interface MediaBarProps {
  media: MediaCard[];
}

const MediaBar: React.FC<MediaBarProps> = ({ media }) => {
  if (!media || media.length === 0) return null;

  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
      {media.slice(0, 3).map((card, i) => (
        <div key={`${card.kind}-${card.url}-${i}`} className="min-w-0 flex-1 sm:max-w-sm">
          {card.kind === 'youtube_video' && card.video_id && (
            <YouTubePlayer
              videoId={card.video_id}
              title={card.title}
              channel={card.channel}
              score={card.score}
              videoType={card.video_type}
              embedded
            />
          )}
          {card.kind === 'youtube_channel' && (
            <YouTubeChannelCard
              channelName={card.channel_name || 'YouTube Channel'}
              handle={card.handle}
              channelUrl={card.url}
              avatarUrl={card.avatar_url}
              featuredVideoId={card.featured_video_id}
            />
          )}
        </div>
      ))}
    </div>
  );
};

export default MediaBar;
