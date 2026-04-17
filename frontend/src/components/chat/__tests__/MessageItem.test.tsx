import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageItem from '../MessageItem';
import type { SourceInfo } from '../../../lib/api';
import type { PipelineState } from '../../../pages/ChatPage';

describe('MessageItem sources', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders citation chips as title-dash-source labels and opens the sources panel callback', () => {
    const onOpenSources = vi.fn();
    const sources: SourceInfo[] = [
      {
        url: 'https://en.wikipedia.org/wiki/Nintendo_Switch_2',
        title: 'Nintendo Switch 2 - Wikipedia',
      },
    ];

    render(
      <MessageItem
        role="assistant"
        content="Specs are here [src:1]"
        timestamp="2026-04-12T12:00:00Z"
        sources={sources}
        onOpenSources={onOpenSources}
      />,
    );

    expect(screen.getByText('Nintendo Switch 2 - Wikipedia')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));

    expect(onOpenSources).toHaveBeenCalledTimes(1);
  });

  it('renders completed pipeline details as an inline accordion instead of an info hover trigger', () => {
    const pipeline: PipelineState = {
      phase: 'completed',
      activity: '',
      augmentation: { latency_ms: 28, context_messages: 3, relevant_facts: 1, past_messages: 0 },
      decomposition: {
        model: 'qwen-fast',
        latency_ms: 142,
        is_course_correction: false,
        reasoning_complexity: 'fast',
        asks: [{ ask_id: 'ask-1', intent: 'knowledge_wiki', distilled_query: 'who is corey feldman' }],
      },
      routing: {
        skills_resolved: 1,
        skills_failed: 0,
        latency_ms: 326,
        routing_log: [
          {
            ask_id: 'ask-1',
            intent: 'knowledge_wiki',
            status: 'success',
            skill_id: 'knowledge_wiki',
            mechanism: 'mediawiki_api',
            latency_ms: 326,
          },
        ],
      },
      synthesis: {
        response: 'Corey Feldman is an American actor.',
        model: 'qwen-fast',
        latency_ms: 184,
        tone: 'helpful',
        platform: 'mac',
      },
      microFastLane: null,
      streamingResponse: '',
      totalLatencyMs: 680,
      confirmations: [],
      clarification: null,
    };

    render(
      <MessageItem
        role="assistant"
        content="Corey Feldman is an American actor."
        timestamp="2026-04-12T12:00:00Z"
        pipeline={pipeline}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Pipeline details' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /thought for 680ms/i }));

    expect(screen.getByText('What I Used')).toBeTruthy();
    expect(screen.getByText('I checked Wikipedia')).toBeTruthy();
    expect(screen.getByText('Wikipedia')).toBeTruthy();
  });
});
