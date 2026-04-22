import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ChatWelcomeView from '../ChatWelcomeView';
import MessageItem from '../MessageItem';

describe('chat density', () => {
  it('renders a larger welcome heading and supporting copy', () => {
    render(<ChatWelcomeView />);

    const heading = screen.getByRole('heading', { name: "Hi, I'm LokiDoki." });
    expect(heading.className).toContain('text-4xl');

    const copy = screen.getByText('Ask me anything to get started.');
    expect(copy.className).toContain('text-base');
  });

  it('renders assistant responses without persistent bubble chrome', () => {
    render(
      <MessageItem
        role="assistant"
        content="This is a test response."
        timestamp="2026-04-12T12:00:00Z"
      />,
    );

    // The assistant side intentionally has no boxed bubble — content
    // flows flush with the avatar column, ChatGPT-style.
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble?.className ?? '').not.toContain('px-7');
    expect(bubble?.className ?? '').not.toContain('py-5');

    // No persistent "assistant" / "LokiDoki" meta label above the
    // response — those were removed as part of the rich-response UI
    // simplification.
    expect(screen.queryByText('assistant')).toBeNull();
    expect(screen.queryByText('LokiDoki')).toBeNull();
  });
});
