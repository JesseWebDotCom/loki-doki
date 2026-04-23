import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageItem from '../MessageItem';
import type { SourceInfo } from '../../../lib/api';
import type { ResponseEnvelope } from '../../../lib/response-types';
import type { PipelineState } from '../../../pages/ChatPage';

const ttsState = vi.hoisted(() => ({
  muted: false,
  speakingKey: null as string | null,
  pendingKey: null as string | null,
  speak: vi.fn(),
  stop: vi.fn(),
  toggleMute: vi.fn(),
  clearSpokenForKey: vi.fn(),
}));

vi.mock('../../../utils/tts', () => ({
  useTTSState: () => ttsState,
  ttsController: {
    updateVisualCursor: vi.fn(),
  },
}));

describe('MessageItem sources', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ttsState.muted = false;
    ttsState.speakingKey = null;
    ttsState.pendingKey = null;
    ttsState.speak.mockReset();
    ttsState.stop.mockReset();
    ttsState.toggleMute.mockReset();
    ttsState.clearSpokenForKey.mockReset();
  });

  it('renders streaming summary content in place and completes without swapping the bubble', () => {
    const streamingEnvelope: ResponseEnvelope = {
      request_id: 'turn-1',
      mode: 'standard',
      status: 'streaming',
      blocks: [
        {
          id: 'summary',
          type: 'summary',
          state: 'partial',
          seq: 1,
          content: 'Luke',
        },
        {
          id: 'sources',
          type: 'sources',
          state: 'loading',
          seq: 0,
          items: [],
        },
      ],
      source_surface: [],
    };

    const { rerender } = render(
      <MessageItem
        role="assistant"
        content=""
        timestamp="2026-04-12T12:00:00Z"
        envelope={streamingEnvelope}
      />,
    );

    expect(screen.getAllByTestId('message-bubble')).toHaveLength(1);
    expect(screen.getByText(/Luke/)).toBeTruthy();
    expect(screen.getByText('▍')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Source 1:/i })).toBeNull();

    rerender(
      <MessageItem
        role="assistant"
        content=""
        timestamp="2026-04-12T12:00:00Z"
        envelope={{
          ...streamingEnvelope,
          blocks: [
            {
              id: 'summary',
              type: 'summary',
              state: 'partial',
              seq: 2,
              content: 'Luke Skywalker',
            },
            streamingEnvelope.blocks[1],
          ],
        }}
      />,
    );

    expect(screen.getAllByTestId('message-bubble')).toHaveLength(1);
    expect(screen.getByText(/Luke Skywalker/)).toBeTruthy();
    expect(screen.getByText('▍')).toBeTruthy();

    rerender(
      <MessageItem
        role="assistant"
        content=""
        timestamp="2026-04-12T12:00:00Z"
        envelope={{
          ...streamingEnvelope,
          status: 'complete',
          source_surface: [
            {
              url: 'https://example.test/luke',
              title: 'Luke - Jedi Archives',
            },
          ],
          blocks: [
            {
              id: 'summary',
              type: 'summary',
              state: 'ready',
              seq: 3,
              content: 'Luke Skywalker is a Jedi Knight.',
            },
            {
              id: 'sources',
              type: 'sources',
              state: 'ready',
              seq: 1,
              items: [
                {
                  url: 'https://example.test/luke',
                  title: 'Luke - Jedi Archives',
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByTestId('message-bubble')).toHaveLength(1);
    expect(screen.getByText(/Luke Skywalker is a Jedi Knight\./)).toBeTruthy();
    expect(screen.queryByText('▍')).toBeNull();
    expect(screen.getByRole('link', { name: /Source 1: Luke - Jedi Archives/i })).toBeTruthy();
  });

  it('keeps live status inline with the streaming assistant message', () => {
    const streamingEnvelope: ResponseEnvelope = {
      request_id: 'turn-1',
      mode: 'standard',
      status: 'streaming',
      blocks: [
        {
          id: 'summary',
          type: 'summary',
          state: 'partial',
          seq: 1,
          content: 'Luke',
        },
      ],
      source_surface: [],
    };

    render(
      <MessageItem
        role="assistant"
        content=""
        timestamp="2026-04-12T12:00:00Z"
        envelope={streamingEnvelope}
        liveStatusText="Consulting Wikipedia"
      />,
    );

    const liveStatus = screen.getByRole('status');
    expect(liveStatus.getAttribute('data-slot')).toBe('assistant-live-status');
    expect(liveStatus.textContent).toContain('Consulting Wikipedia');
    expect(screen.queryByLabelText('Details')).toBeNull();
  });

  it('suppresses the duplicate status block when inline live status is active', () => {
    const streamingEnvelope: ResponseEnvelope = {
      request_id: 'turn-1',
      mode: 'rich',
      status: 'streaming',
      blocks: [
        {
          id: 'status',
          type: 'status',
          state: 'partial',
          seq: 1,
          content: 'Consulting Wikipedia',
        },
        {
          id: 'summary',
          type: 'summary',
          state: 'partial',
          seq: 2,
          content: 'Luke Skywalker is a fictional character.',
        },
      ],
      source_surface: [],
    };

    const { container } = render(
      <MessageItem
        role="assistant"
        content=""
        timestamp="2026-04-12T12:00:00Z"
        envelope={streamingEnvelope}
        liveStatusText="Consulting Wikipedia"
      />,
    );

    const inlineStatuses = container.querySelectorAll('[data-slot="assistant-live-status"]');
    expect(inlineStatuses).toHaveLength(1);
    expect(inlineStatuses[0]?.textContent).toContain('Consulting Wikipedia');
    expect(container.querySelector('[data-slot="status-block"]')).toBeNull();
    expect(screen.getByText(/Luke Skywalker is a fictional character\./)).toBeTruthy();
  });

  it('keeps the stop control visible while a streaming message is actively speaking', () => {
    ttsState.pendingKey = 'msg-0';
    const streamingEnvelope: ResponseEnvelope = {
      request_id: 'turn-1',
      mode: 'standard',
      status: 'streaming',
      blocks: [
        {
          id: 'summary',
          type: 'summary',
          state: 'partial',
          seq: 1,
          content: 'Luke',
        },
      ],
      source_surface: [],
    };

    render(
      <MessageItem
        role="assistant"
        content="Luke"
        timestamp="2026-04-12T12:00:00Z"
        messageKey="msg-0"
        envelope={streamingEnvelope}
      />,
    );

    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Play' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders compact citation chips (source name visible, full title-dash-source in aria-label) and opens the sources panel callback', () => {
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

    const chips = screen.getAllByRole('link', { name: /Source 1: Nintendo Switch 2 - Wikipedia/ });
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].textContent).toContain('Wikipedia');

    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));

    expect(onOpenSources).toHaveBeenCalledTimes(1);
  });

  it('gates pipeline details behind a hover-revealed Details toggle', () => {
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

    // Details are hidden by default — no accordion, no inline meta.
    expect(screen.queryByRole('button', { name: /thought for 680ms/i })).toBeNull();

    // Clicking the hover-gated Details toggle reveals the accordion
    // already expanded (one-click UX — no second click to see contents).
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByRole('button', { name: /thought for 680ms/i })).toBeTruthy();
    expect(screen.getByText('Checking Sources')).toBeTruthy();
    expect(screen.getAllByText(/Wikipedia/i).length).toBeGreaterThan(0);
  });
});
