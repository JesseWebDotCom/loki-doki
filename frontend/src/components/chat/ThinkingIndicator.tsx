import React from 'react';
import type { PipelineState } from '../../pages/ChatPage';
import PipelineInfoPopover from './PipelineInfoPopover';

interface ThinkingIndicatorProps {
  pipeline: PipelineState;
  avatar?: React.ReactNode;
  /** Interim text shown inline while a knowledge-gap search runs. */
  interimText?: string;
}

const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ pipeline, avatar, interimText }) => {
  if (pipeline.phase === 'idle') return null;

  return (
    <div className={`${pipeline.phase === 'completed' ? 'mb-2' : 'mb-8'} w-full`}>
      <div className="flex items-start gap-4">
        {avatar}
        <div className="min-w-0 flex-1 pt-1">
          <PipelineInfoPopover pipeline={pipeline} currentPhase={pipeline.phase} />
          {interimText && (
            <p className="mt-2 text-sm text-muted-foreground animate-pulse">{interimText}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ThinkingIndicator;
