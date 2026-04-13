import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { ThumbsUp, ThumbsDown, MessageSquare, Send } from 'lucide-react';
import { submitMessageFeedback } from '../../lib/api';
import { toast } from 'sonner';

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: number;
  initialRating: 1 | -1;
  traceJson?: string;
  onSuccess?: (rating: 1 | -1) => void;
}

const POSITIVE_TAGS = [
  'accurate',
  'helpful',
  'humanistic',
  'concise',
  'well-structured',
  'good tone',
];

  'no memory',
  'bad memory',
  'hallucination',
  'wrong subject',
  'response cutoff',
  'bad formatting',
  'too detailed',
  'too robotic',
  'too verbose',
  'irrelevant',
  'cold/clinical',
];

export const FeedbackDialog: React.FC<FeedbackDialogProps> = ({
  open,
  onOpenChange,
  messageId,
  initialRating,
  traceJson,
  onSuccess,
}) => {
  const [comment, setComment] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const tags = initialRating === 1 ? POSITIVE_TAGS : NEGATIVE_TAGS;
  const isPositive = initialRating === 1;

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await submitMessageFeedback(messageId, initialRating, comment, selectedTags, traceJson);
      toast.success('Feedback submitted. Thanks for helping me improve!');
      onSuccess?.(initialRating);
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      toast.error('Failed to submit feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px] border-border/40 bg-card overflow-hidden shadow-m3">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className={`p-2 rounded-xl ${isPositive ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
              {isPositive ? <ThumbsUp size={20} /> : <ThumbsDown size={20} />}
            </div>
            <div>
              <DialogTitle className="text-xl font-bold tracking-tight">
                {isPositive ? 'Why was this good?' : 'What went wrong?'}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground font-medium">
                Your feedback helps LokiDoki get better over time.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="space-y-3">
            <Label className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60">
              Quick Selection
            </Label>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${
                      isSelected
                        ? 'bg-primary border-primary text-primary-foreground shadow-md scale-105'
                        : 'bg-muted/50 border-border/30 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3">
            <Label htmlFor="comment" className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60 flex items-center gap-2">
              <MessageSquare size={12} />
              Additional Details
            </Label>
            <textarea
              id="comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={isPositive ? "Any specific praise or details?" : "Tell us more about the error..."}
              className="w-full min-h-[100px] rounded-xl bg-muted/40 border border-border/30 p-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all resize-none placeholder:text-muted-foreground/40"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="rounded-xl font-bold"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="rounded-xl font-bold gap-2 px-6"
          >
            {isSubmitting ? (
              <span className="animate-spin mr-2">◌</span>
            ) : (
              <Send size={14} />
            )}
            Submit Feedback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
