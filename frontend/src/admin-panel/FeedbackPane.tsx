import React, { useEffect, useState, useCallback } from 'react';
import { MessageSquare, ThumbsUp, ThumbsDown, Calendar, Copy, Cpu, Zap, MessageCircle, Trash2 } from 'lucide-react';
import { listMessageFeedback, deleteMessageFeedback } from '../lib/api';
import Badge from '../components/ui/Badge';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
import { useUsers } from './useUsers';
import ConfirmDialog from '../components/ui/ConfirmDialog';

interface FeedbackEntry {
  id: number;
  message_id: number;
  rating: number;
  comment: string;
  tags: string; 
  snapshot_prompt: string | null;
  snapshot_response: string | null;
  trace_json: string | null;
  created_at: string;
  session_id: number;
  username?: string;
}

const FeedbackPane: React.FC = () => {
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterRating, setFilterRating] = useState<number | undefined>(undefined);
  const { users } = useUsers();
  
  const params = new URLSearchParams(window.location.search);
  const initialUserId = Number(params.get('user')) || undefined;
  const [selectedUserId, setSelectedUserId] = useState<number | undefined>(initialUserId);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const loadFeedback = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await listMessageFeedback(filterRating, 100, selectedUserId);
      setFeedback(res.feedback);
    } catch (err) {
      console.error('Failed to load feedback:', err);
      toast.error('Failed to load feedback');
    } finally {
      setIsLoading(false);
    }
  }, [filterRating, selectedUserId]);

  useEffect(() => {
    loadFeedback();
  }, [loadFeedback]);

  const copyTrace = async (entry: FeedbackEntry) => {
    if (!entry.trace_json) {
      toast.error('No trace captured for this feedback.');
      return;
    }
    await navigator.clipboard.writeText(entry.trace_json);
    toast.success('Trace copied to clipboard');
  };

  const copyAllInfo = async (entry: FeedbackEntry) => {
    const text = `
Rating: ${entry.rating === 1 ? 'Positive' : 'Negative'}
Tags: ${JSON.parse(entry.tags || '[]').join(', ')}
User: ${entry.username || 'unknown'}
Comment: ${entry.comment || 'none'}
Prompt: ${entry.snapshot_prompt || 'none'}
Response: ${entry.snapshot_response || 'none'}
`.trim();
    await navigator.clipboard.writeText(text);
    toast.success('Feedback info copied');
  };

  const copyAllTraces = async () => {
    const traces = feedback
      .filter(f => f.trace_json)
      .map(f => ({
        id: f.id,
        username: f.username,
        rating: f.rating,
        prompt: f.snapshot_prompt,
        response: f.snapshot_response,
        trace: JSON.parse(f.trace_json!)
      }));
    
    if (traces.length === 0) {
      toast.error('No traces available to copy.');
      return;
    }

    await navigator.clipboard.writeText(JSON.stringify(traces, null, 2));
    toast.success(`Copied ${traces.length} traces to clipboard`);
  };

  const clearFeedback = async () => {
    try {
      const res = await deleteMessageFeedback(undefined, selectedUserId);
      toast.success(`Cleared ${res.deleted_count} feedback entries`);
      void loadFeedback();
    } catch (err) {
      toast.error('Failed to clear feedback');
    } finally {
      setShowClearConfirm(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 pb-6 border-b border-border/10">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-m3">
            <MessageSquare size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Feedback Review</h1>
            <p className="text-xs font-medium text-muted-foreground">
              Reviewing {feedback.length} quality signals across the system.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* User Switcher */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase text-muted-foreground mr-1">User:</span>
            <select
              value={selectedUserId ?? ''}
              onChange={(e) => setSelectedUserId(e.target.value ? Number(e.target.value) : undefined)}
              className="bg-card/50 border border-border/40 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-primary/40 h-10 min-w-[140px]"
            >
              <option value="">All Users</option>
              {users.filter(u => u.status !== 'deleted').map(u => (
                <option key={u.id} value={u.id}>{u.username}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 rounded-2xl border border-border/20 bg-card/50 p-1 h-10">
            <Button 
              variant={filterRating === undefined ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilterRating(undefined)}
              className="text-[10px] font-bold rounded-xl px-3 h-8"
            >
              All
            </Button>
            <Button 
              variant={filterRating === 1 ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilterRating(1)}
              className="text-[10px] font-bold rounded-xl px-3 h-8 gap-1.5"
            >
              <ThumbsUp size={10} className="text-green-400" /> Pos
            </Button>
            <Button 
              variant={filterRating === -1 ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilterRating(-1)}
              className="text-[10px] font-bold rounded-xl px-3 h-8 gap-1.5"
            >
              <ThumbsDown size={10} className="text-red-400" /> Neg
            </Button>
          </div>

          <div className="h-6 w-px bg-border/20 mx-1 hidden sm:block" />

          <Button
            variant="outline"
            size="sm"
            onClick={copyAllTraces}
            className="text-[10px] font-bold rounded-xl gap-2 h-10 px-4 border-border/30 bg-card/50 hover:bg-card"
          >
            <Copy size={12} /> Copy All
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowClearConfirm(true)}
            className="text-[10px] font-bold rounded-xl gap-2 h-10 px-4 border-red-400/20 text-red-400 bg-red-400/5 hover:bg-red-400/10"
          >
            <Trash2 size={12} /> {selectedUserId ? 'Clear User' : 'Clear All'}
          </Button>
        </div>
      </header>

      <div className="space-y-6 pt-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="animate-spin text-primary font-bold text-2xl">◌</div>
            <p className="text-muted-foreground font-medium animate-pulse text-sm">Retrieving feedback signals...</p>
          </div>
        ) : feedback.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-4 border-2 border-dashed border-border/10 rounded-3xl bg-card/10">
            <div className="p-4 rounded-full bg-muted/20 text-muted-foreground/30">
              <MessageCircle size={40} />
            </div>
            <div>
              <h3 className="text-sm font-bold">No feedback signals found</h3>
              <p className="text-muted-foreground text-xs">Adjust your filters or user selection.</p>
            </div>
          </div>
        ) : (
          feedback.map((entry) => {
            const tags = JSON.parse(entry.tags || '[]');
            const isPositive = entry.rating === 1;
            
            return (
              <div key={entry.id} className="group relative bg-card/50 border border-border/30 rounded-3xl overflow-hidden hover:shadow-m4 transition-all duration-300 hover:border-primary/20">
                <div className="flex flex-col lg:flex-row divide-y lg:divide-y-0 lg:divide-x divide-border/20">
                  {/* Left Side: Rating & Meta */}
                  <div className="w-full lg:w-64 p-5 bg-muted/10 flex flex-col justify-between gap-5">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`p-1.5 rounded-lg ${isPositive ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
                            {isPositive ? <ThumbsUp size={14} /> : <ThumbsDown size={14} />}
                          </div>
                          <span className={`text-[10px] font-bold uppercase tracking-widest ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                            {isPositive ? 'Accurate' : 'Issue'}
                          </span>
                        </div>
                        {entry.username && (
                          <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                            {entry.username}
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void copyAllInfo(entry)}
                          className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-primary transition-colors ml-1"
                          title="Copy details"
                        >
                          <Copy size={12} />
                        </Button>
                      </div>

                      <div className="flex flex-wrap gap-1">
                        {tags.map((tag: string) => (
                          <Badge key={tag} variant={isPositive ? 'success' : 'warning'} className="text-[8px] h-4 px-1">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-4">
                      {entry.comment && (
                        <div className="p-3 rounded-xl bg-card border border-border/40 text-[11px] font-medium leading-relaxed italic text-muted-foreground/80">
                          "{entry.comment}"
                        </div>
                      )}
                      
                      <div className="flex items-center gap-2 text-[9px] text-muted-foreground font-bold uppercase tracking-wider">
                        <Calendar size={10} className="opacity-50" />
                        {new Intl.DateTimeFormat('en-US', { 
                          month: 'short', 
                          day: 'numeric', 
                          hour: 'numeric', 
                          minute: '2-digit', 
                        }).format(new Date(entry.created_at))}
                      </div>
                    </div>
                  </div>

                  {/* Right Side: Context Snapshots */}
                  <div className="flex-1 p-6 space-y-6">
                    <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-[9px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                           Prompt
                        </div>
                        <div className="text-xs font-medium leading-relaxed bg-primary/5 p-4 rounded-2xl border border-primary/10 min-h-[80px]">
                          {entry.snapshot_prompt || <span className="italic opacity-30 text-[10px]">No prompt captured</span>}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-[9px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                           Response
                        </div>
                        <div className="text-xs font-medium leading-relaxed bg-muted/5 p-4 rounded-2xl border border-border/20 whitespace-pre-wrap min-h-[80px]">
                          {entry.snapshot_response || <span className="italic opacity-30 text-[10px]">No response captured</span>}
                        </div>
                      </div>
                    </section>

                    {/* Trace Insights */}
                    {entry.trace_json && (() => {
                      let trace;
                      try {
                        trace = JSON.parse(entry.trace_json);
                      } catch {
                        return null;
                      }
                      const steps = trace as any[];
                      const totalLatency = steps.reduce((acc, s) => acc + (s.timing_ms || 0), 0);
                      const bottleneck = steps.reduce((prev, curr) => (curr.timing_ms > prev.timing_ms) ? curr : prev, steps[0]);
                      const skillsStep = steps.find(s => s.name === 'execute');
                      const skillsUsed = skillsStep?.details?.chunks?.map((c: any) => c.capability).filter(Boolean) || [];

                      return (
                        <div className="pt-4 border-t border-border/10 space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="text-[9px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                               Trace Analysis
                            </div>
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              onClick={() => void copyTrace(entry)}
                              className="h-6 text-[9px] font-bold uppercase gap-1.5 text-muted-foreground hover:text-primary"
                            >
                              <Copy size={10} /> Copy JSON
                            </Button>
                          </div>
                          
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div className="p-3 rounded-xl border border-border/20 bg-card/60 space-y-0.5">
                              <div className="flex items-center gap-1.5 text-[8px] font-bold text-muted-foreground/60 uppercase">
                                <Zap size={8} className="text-yellow-400" /> Latency
                              </div>
                              <div className="text-sm font-bold tabular-nums">
                                {(totalLatency / 1000).toFixed(2)}s
                              </div>
                            </div>

                            <div className="p-3 rounded-xl border border-border/20 bg-card/60 space-y-0.5">
                              <div className="flex items-center gap-1.5 text-[8px] font-bold text-muted-foreground/60 uppercase">
                                <Zap size={8} className="text-red-400" /> Delay
                              </div>
                              <div className="text-sm font-bold truncate">
                                {bottleneck?.name || '—'} 
                                <span className="text-[10px] font-medium text-muted-foreground ml-1">
                                  ({(bottleneck?.timing_ms || 0).toFixed(0)}ms)
                                </span>
                              </div>
                            </div>

                            <div className="p-3 rounded-xl border border-border/20 bg-card/60 space-y-0.5">
                              <div className="flex items-center gap-1.5 text-[8px] font-bold text-muted-foreground/60 uppercase">
                                <Cpu size={8} className="text-primary" /> Skills
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {skillsUsed.length > 0 ? (
                                  skillsUsed.map((s: string) => (
                                    <Badge key={s} variant="outline" className="text-[8px] h-3.5 px-1 font-bold">
                                      {s}
                                    </Badge>
                                  ))
                                ) : (
                                  <span className="text-[10px] font-bold text-muted-foreground/20">NONE</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={showClearConfirm}
        title={selectedUserId ? "Clear user feedback?" : "Clear all feedback?"}
        description={selectedUserId 
          ? `Wipe all quality signals and traces for this user? This cannot be undone.`
          : `Wipe all quality signals and traces for ALL users? This cannot be undone.`}
        confirmLabel="Clear Data"
        destructive
        onConfirm={() => void clearFeedback()}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
};

export default FeedbackPane;
