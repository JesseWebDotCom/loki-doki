import React, { useState } from 'react';
import type { MediaCard } from '../../lib/api';
import YouTubePlayer from './YouTubePlayer';
import YouTubeChannelCard from './YouTubeChannelCard';

interface MediaBarProps {
  media: MediaCard[];
}

const ImageTile: React.FC<{
  url: string;
  caption?: string;
  sourceLabel?: string;
}> = ({ url, caption, sourceLabel }) => {
  // When a DDG / web-image URL 404s or returns HTML, the browser
  // falls back to rendering the ``alt`` text inside the image slot —
  // users saw article titles rendered as image content. Hide the
  // whole tile instead on any load failure, so we never substitute
  // text for what should be a picture.
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure
      className="group relative h-40 w-28 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/20 sm:h-48 sm:w-36"
      title={caption || undefined}
    >
      <img
        src={url}
        alt={caption || 'Image'}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
      {sourceLabel && (
        <figcaption className="absolute bottom-0 right-0 rounded-tl-md bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white/85">
          {sourceLabel}
        </figcaption>
      )}
    </figure>
  );
};

const MediaBar: React.FC<MediaBarProps> = ({ media }) => {
  if (!media || media.length === 0) return null;

  // ChatGPT-style media header: compact fixed-height row that wraps on
  // overflow. Images are cropped to a uniform aspect ratio so a mixed
  // set (portrait + landscape + YouTube thumbnail) still reads as one
  // strip. YouTube cards keep their own card chrome; images get a
  // thumbnail-style tile with a small caption beneath.
  const imageOnly = media.every((c) => c.kind === 'image');

  return (
    <div
      className={`mb-4 flex gap-2 ${
        imageOnly ? 'flex-row flex-wrap' : 'flex-col sm:flex-row sm:flex-wrap sm:items-stretch'
      }`}
    >
      {media.slice(0, 3).map((card, i) => {
        if (card.kind === 'youtube_video' && card.video_id) {
          return (
            <div
              key={`${card.kind}-${card.url}-${i}`}
              className="min-w-0 flex-1 sm:max-w-sm"
            >
              <YouTubePlayer
                videoId={card.video_id}
                title={card.title}
                channel={card.channel}
                score={card.score}
                videoType={card.video_type}
                embedded
              />
            </div>
          );
        }
        if (card.kind === 'youtube_channel') {
          return (
            <div
              key={`${card.kind}-${card.url}-${i}`}
              className="min-w-0 flex-1 sm:max-w-sm"
            >
              <YouTubeChannelCard
                channelName={card.channel_name || 'YouTube Channel'}
                handle={card.handle}
                channelUrl={card.url}
                avatarUrl={card.avatar_url}
                featuredVideoId={card.featured_video_id}
              />
            </div>
          );
        }
        if (card.kind === 'image') {
          const tile = (
            <ImageTile
              url={card.url}
              caption={card.caption}
              sourceLabel={card.source_label}
            />
          );
          if (card.url.startsWith('http')) {
            return (
              <a
                key={`${card.kind}-${card.url}-${i}`}
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                className="contents"
              >
                {tile}
              </a>
            );
          }
          return (
            <React.Fragment key={`${card.kind}-${card.url}-${i}`}>
              {tile}
            </React.Fragment>
          );
        }
        return null;
      })}
    </div>
  );
};

export default MediaBar;
