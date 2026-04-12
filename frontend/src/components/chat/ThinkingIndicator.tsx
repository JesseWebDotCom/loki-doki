import React from 'react';
import type { PipelineState } from '../../pages/ChatPage';
import PipelineInfoPopover from './PipelineInfoPopover';

interface ThinkingIndicatorProps {
  pipeline: PipelineState;
  avatar?: React.ReactNode;
}

const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ pipeline, avatar }) => {
  if (pipeline.phase === 'idle') return null;

  return (
    <div className={`${pipeline.phase === 'completed' ? 'mb-2' : 'mb-8'} w-full`}>
      <div className="flex items-start gap-4">
        {avatar}
        <div className="min-w-0 flex-1 pt-1">
          <PipelineInfoPopover pipeline={pipeline} currentPhase={pipeline.phase} />
        </div>
      </div>
    </div>
  );
};

export default ThinkingIndicator;
