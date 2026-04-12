import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageItem from '../MessageItem';
import type { SourceInfo } from '../../../lib/api';

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
});
