import React from 'react';
import { Cpu, Layers, Timer, Activity } from 'lucide-react';
import Badge from '../ui/Badge';
import type { PipelineState } from '../../pages/ChatPage';
import { formatDuration } from '../../lib/utils';

interface MetricProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  status?: 'active' | 'success' | 'warning';
}

interface StatusMetricsProps {
  pipeline?: PipelineState;
}

const MetricRow: React.FC<MetricProps> = ({ icon, label, value, status = 'active' }) => (
  <div className="flex items-center justify-between py-3 border-b border-gray-800/10 last:border-0 hover:bg-white/5 transition-colors px-2 rounded-lg">
    <div className="flex items-center gap-3">
      <div className="p-1.5 rounded-md bg-white/5 text-gray-500">{icon}</div>
      <span className="text-xs font-semibold text-gray-500 tracking-tight uppercase">{label}</span>
    </div>
    <div className="flex items-center gap-2">
      <div className="text-xs font-mono text-gray-300 font-bold">{value}</div>
      {status === 'active' && <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(151,71,255,0.5)]" />}
    </div>
  </div>
);

const StatusMetrics: React.FC<StatusMetricsProps> = ({ pipeline }) => {
  const decompModel = pipeline?.decomposition?.model ?? 'gemma4:e2b';
  const synthModel = pipeline?.synthesis?.model ?? '--';
  const totalMs = pipeline?.totalLatencyMs
    ? formatDuration(pipeline.totalLatencyMs)
    : '--';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-4 px-2">
        <h3 className="text-[10px] font-bold text-gray-600 uppercase tracking-widest flex items-center gap-2">
          <Activity size={12} className="text-gray-500" />
          Hardware Residence
        </h3>
        <Badge variant="success">Resident</Badge>
      </div>

      <MetricRow icon={<Cpu size={14}/>} label="Router" value={decompModel} />
      <MetricRow icon={<Layers size={14}/>} label="Synth" value={synthModel} />
      <MetricRow icon={<Timer size={14}/>} label="Pipeline" value={totalMs} />

      <div className="mt-8 px-2">
        <div className="p-4 rounded-xl bg-primary/5 border border-primary/10 shadow-m1">
          <div className="text-[9px] font-bold text-primary uppercase tracking-widest mb-1 opacity-60 font-sans">
            System Status
          </div>
          <div className="text-xs text-gray-400 leading-snug font-medium italic">
            {pipeline?.phase && pipeline.phase !== 'idle'
              ? `Processing: ${pipeline.phase} phase active`
              : 'Pipeline idle. Ready for input.'}
          </div>
        </div>
      </div>
    </div>
  );
};

export default StatusMetrics;
