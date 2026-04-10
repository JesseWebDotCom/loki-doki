import React, { useEffect, useState } from 'react';
import { MessageSquare, ThumbsUp, ThumbsDown, Calendar, ExternalLink, MessageCircle } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import { listMessageFeedback } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import Badge from '../components/ui/Badge';
import { Button } from '../components/ui/button';


interface FeedbackEntry {
  id: number;
  message_id: number;
  rating: number;
  comment: string;
  tags: string; // JSON string from backend
  snapshot_prompt: string | null;
  snapshot_response: string | null;
  created_at: string;
  session_id: number;
}

const FeedbackPage: React.FC = () => {
  useDocumentTitle('Feedback Review');
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterRating, setFilterRating] = useState<number | undefined>(undefined);

  const loadFeedback = async () => {
    setIsLoading(true);
    try {
      const res = await listMessageFeedback(filterRating);
      setFeedback(res.feedback);
    } catch (err) {
      console.error('Failed to load feedback:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadFeedback();
  }, [filterRating]);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar />
      <main className="flex-1 flex flex-col bg-background overflow-hidden">
        <header className="p-10 border-b border-border/10">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-m3">
                <MessageSquare size={28} />
              </div>
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Feedback Review</h1>
                <p className="text-muted-foreground text-sm font-medium">
                  Reviewing {feedback.length} quality signals from your interactions.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 bg-card/50 border border-border/20 p-1.5 rounded-xl">
              <Button 
                variant={filterRating === undefined ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilterRating(undefined)}
                className="text-xs font-bold rounded-lg px-4"
              >
                All
              </Button>
              <Button 
                variant={filterRating === 1 ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilterRating(1)}
                className="text-xs font-bold rounded-lg px-4 gap-2"
              >
                <ThumbsUp size={12} className="text-green-400" /> Positive
              </Button>
              <Button 
                variant={filterRating === -1 ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilterRating(-1)}
                className="text-xs font-bold rounded-lg px-4 gap-2"
              >
                <ThumbsDown size={12} className="text-red-400" /> Negative
              </Button>
            </div>
          </div>
        </header>

        <section className="flex-1 overflow-y-auto p-10 bg-gradient-to-b from-transparent to-card/20">
          <div className="max-w-5xl mx-auto space-y-6">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <div className="animate-spin text-primary">◌</div>
                <p className="text-muted-foreground font-medium animate-pulse">Retrieving feedback signals...</p>
              </div>
            ) : feedback.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center gap-4 border-2 border-dashed border-border/20 rounded-3xl">
                <div className="p-4 rounded-full bg-muted/20 text-muted-foreground/30">
                  <MessageCircle size={48} />
                </div>
                <div>
                  <h3 className="text-lg font-bold">No feedback yet</h3>
                  <p className="text-muted-foreground text-sm">Feedback submitted in chats will appear here for review.</p>
                </div>
              </div>
            ) : (
              feedback.map((entry) => {
                const tags = JSON.parse(entry.tags || '[]');
                const isPositive = entry.rating === 1;
                
                return (
                  <div key={entry.id} className="group relative bg-card border border-border/30 rounded-3xl overflow-hidden hover:shadow-m4 transition-all duration-300 hover:border-primary/20">
                    <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-border/20">
                      {/* Left Side: Rating & Meta */}
                      <div className="w-full md:w-64 p-6 bg-muted/10 flex flex-col justify-between gap-6">
                        <div className="space-y-4">
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-xl shadow-sm ${isPositive ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
                              {isPositive ? <ThumbsUp size={18} /> : <ThumbsDown size={18} />}
                            </div>
                            <span className={`text-sm font-bold uppercase tracking-widest ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                              {isPositive ? 'Accurate' : 'Issue'}
                            </span>
                          </div>

                          <div className="flex flex-wrap gap-1.5">
                            {tags.map((tag: string) => (
                              <Badge key={tag} variant={isPositive ? 'success' : 'warning'} className="text-[9px]">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-4">
                          {entry.comment && (
                            <div className="p-4 rounded-2xl bg-card border border-border/40 text-xs font-medium leading-relaxed italic text-muted-foreground/80">
                              "{entry.comment}"
                            </div>
                          )}
                          
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-bold uppercase tracking-wider">
                            <Calendar size={12} className="opacity-50" />
                            {new Intl.DateTimeFormat('en-US', { 
                              month: 'short', 
                              day: 'numeric', 
                              hour: 'numeric', 
                              minute: '2-digit', 
                              hour12: true 
                            }).format(new Date(entry.created_at))}
                          </div>
                        </div>
                      </div>

                      {/* Right Side: Context Snapshots */}
                      <div className="flex-1 p-8 space-y-6">
                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                            <span className="w-8 h-px bg-border/20" /> Prompt
                          </div>
                          <div className="text-sm font-medium leading-relaxed pl-4 border-l-2 border-primary/20 bg-primary/5 p-4 rounded-r-2xl rounded-bl-2xl">
                            {entry.snapshot_prompt || <span className="italic opacity-30">No prompt captured</span>}
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                            <span className="w-8 h-px bg-border/20" /> LokiDoki Response
                          </div>
                          <div className="text-sm font-medium leading-relaxed pl-4 border-l-2 border-muted-foreground/20 bg-muted/5 p-4 rounded-r-2xl rounded-bl-2xl whitespace-pre-wrap">
                            {entry.snapshot_response || <span className="italic opacity-30">No response captured</span>}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Action Hover Button */}
                    <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="rounded-full bg-card shadow-sm hover:text-primary">
                        <ExternalLink size={14} />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default FeedbackPage;
