import React from 'react';
import { Brain, Target, Clock, Heart } from 'lucide-react';
import Badge from '../ui/Badge';
import type { DecompositionData } from '../../lib/api';
import { formatDuration } from '../../lib/utils';

interface DecompositionPanelProps {
  data: DecompositionData;
}

const DecompositionPanel: React.FC<DecompositionPanelProps> = ({ data }) => {
  return (
    <div className="space-y-4">
      {/* Model & Latency */}
      <div className="flex items-center justify-between px-2 py-2 rounded-lg bg-card/30 border border-border/20">
        <div className="flex items-center gap-2">
          <Brain size={14} className="text-primary" />
          <span className="text-xs font-bold font-mono text-foreground">{data.model}</span>
        </div>
        <div className="flex items-center gap-2">
          <Clock size={12} className="text-muted-foreground" />
          <span className="text-xs font-mono text-primary font-bold">{formatDuration(data.latency_ms)}</span>
        </div>
      </div>

      {/* Reasoning Level */}
      <div className="flex items-center gap-2 px-2">
        <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">Reasoning</span>
        <Badge variant={data.reasoning_complexity === 'thinking' ? 'warning' : 'success'}>
          {data.reasoning_complexity}
        </Badge>
        {data.is_course_correction && (
          <Badge variant="warning">Course Correction</Badge>
        )}
      </div>

      {/* Sentiment */}
      {data.sentiment?.sentiment && (
        <div className="flex items-center gap-2 px-2">
          <Heart size={12} className="text-pink-400" />
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">Sentiment</span>
          <span className="text-xs text-foreground font-medium">{data.sentiment.sentiment}</span>
          {data.sentiment.concern && (
            <span className="text-[10px] text-muted-foreground italic truncate">({data.sentiment.concern})</span>
          )}
        </div>
      )}

      {/* Parsed Asks */}
      {data.asks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-2">
            <Target size={12} className="text-primary" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">
              Asks ({data.asks.length})
            </span>
          </div>
          {data.asks.map((ask) => (
            <div
              key={ask.ask_id}
              className="px-3 py-2 rounded-lg bg-primary/5 border border-primary/10 space-y-1"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-primary font-bold">{ask.intent}</span>
                <span className="text-[9px] text-muted-foreground font-mono">{ask.ask_id}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-snug truncate">{ask.distilled_query}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default DecompositionPanel;
