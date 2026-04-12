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

  it('renders assistant responses with roomier bubble and body typography', () => {
    render(
      <MessageItem
        role="assistant"
        content="This is a test response."
        timestamp="2026-04-12T12:00:00Z"
      />,
    );

    const bubble = screen.getByTestId('message-bubble');
    expect(bubble?.className ?? '').toContain('px-7');
    expect(bubble?.className ?? '').toContain('py-5');

    const assistantLabel = screen.getByText('assistant');
    expect(assistantLabel.className).toContain('text-xs');

    const body = screen.getByText('This is a test response.').closest('div.prose-onyx');
    expect(body?.className ?? '').toContain('text-base');
    expect(body?.className ?? '').toContain('leading-8');
  });
});
