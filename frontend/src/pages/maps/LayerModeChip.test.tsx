import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import LayerModeChip from './LayerModeChip';

describe('LayerModeChip', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders both Map and 3D options with correct aria-pressed state', () => {
    render(<LayerModeChip mode="map" onChange={() => { /* no-op */ }} />);
    const mapBtn = screen.getByRole('button', { name: 'Map' });
    const threeDBtn = screen.getByRole('button', { name: '3D' });
    expect(mapBtn.getAttribute('aria-pressed')).toBe('true');
    expect(threeDBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('reflects the 3D mode on the 3D button', () => {
    render(<LayerModeChip mode="3d" onChange={() => { /* no-op */ }} />);
    expect(screen.getByRole('button', { name: '3D' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking the inactive option fires onChange with that mode', () => {
    const onChange = vi.fn();
    render(<LayerModeChip mode="map" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('3d');
  });

  it('clicking the already-active option is a no-op (no onChange)', () => {
    const onChange = vi.fn();
    render(<LayerModeChip mode="map" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('exposes a group role with a descriptive aria-label', () => {
    render(<LayerModeChip mode="map" onChange={() => { /* no-op */ }} />);
    const group = screen.getByRole('group', { name: 'Layer mode' });
    expect(group).toBeDefined();
  });
});
