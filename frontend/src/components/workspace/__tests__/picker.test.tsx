import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import WorkspacePicker from '../WorkspacePicker';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    className?: string;
  }) => (
    <button type="button" className={className} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

describe('WorkspacePicker', () => {
  it('renders the active workspace and emits selection callbacks', () => {
    const onSelect = vi.fn();
    const onManage = vi.fn();

    render(
      <WorkspacePicker
        activeWorkspaceId="road-trip"
        onSelect={onSelect}
        onManage={onManage}
        workspaces={[
          {
            id: 'default',
            name: 'Default',
            persona_id: 'default',
            default_mode: 'standard',
            attached_corpora: [],
            tone_hint: null,
            memory_scope: 'global',
          },
          {
            id: 'road-trip',
            name: 'Car Road Trip',
            persona_id: 'driving-assistant',
            default_mode: 'rich',
            attached_corpora: ['maps-east-coast'],
            tone_hint: 'calm copilot',
            memory_scope: 'workspace',
          },
        ]}
      />,
    );

    expect(screen.getAllByText('Car Road Trip').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Default'));
    expect(onSelect).toHaveBeenCalledWith('default');

    fireEvent.click(screen.getByText('Manage Workspaces'));
    expect(onManage).toHaveBeenCalled();
  });
});
