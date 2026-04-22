import React from 'react';
import type { PipelineState } from '../../pages/ChatPage';
import PipelineInfoPopover from './PipelineInfoPopover';

interface ThinkingIndicatorProps {
  pipeline: PipelineState;
  avatar?: React.ReactNode;
  /** Interim text shown inline while a knowledge-gap search runs. */
  interimText?: string;
}

function cleanInterim(text: string): string {
  // Strip the ``<spoken_text>`` island (closed or still-streaming) so
  // the interim preview never flashes the raw tag. Mirrors the
  // SummaryBlock preprocessor.
  let out = text.replace(/\s*<spoken_text>[\s\S]*?<\/spoken_text>/gi, "");
  out = out.replace(/\s*<spoken_text>[\s\S]*$/i, "");
  return out;
}

const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ pipeline, avatar, interimText }) => {
  if (pipeline.phase === 'idle') return null;

  const cleaned = interimText ? cleanInterim(interimText) : '';

  return (
    <div className={`${pipeline.phase === 'completed' ? 'mb-2' : 'mb-8'} w-full`}>
      <div className="flex items-start gap-4">
        {avatar}
        <div className="min-w-0 flex-1 pt-1">
          <PipelineInfoPopover pipeline={pipeline} currentPhase={pipeline.phase} />
          {cleaned && (
            <p className="mt-2 text-sm text-muted-foreground animate-pulse">{cleaned}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ThinkingIndicator;
