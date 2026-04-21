import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PoiHoverPreview from './PoiHoverPreview';

describe('PoiHoverPreview', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the name and detail lines at the given screen coords', () => {
    render(
      <PoiHoverPreview
        name="Bridgewater Associates"
        categoryLabel="Office"
        addressLines={['One Nyala Farms Rd, Westport, CT']}
        category="office"
        screenX={120}
        screenY={48}
      />,
    );

    expect(screen.getByText('Bridgewater Associates')).toBeTruthy();
    expect(screen.getByText('Office')).toBeTruthy();
    expect(
      screen.getByText('One Nyala Farms Rd, Westport, CT'),
    ).toBeTruthy();

    const card = screen.getByTestId('poi-hover-preview');
    expect(card.style.position).toBe('fixed');
    expect(card.style.left).toBe('132px');
    expect(card.style.top).toBe('60px');
    // Interactive card (has buttons) so the role is dialog, not tooltip.
    expect(card.getAttribute('role')).toBe('dialog');
  });

  it('renders the sprite image when the category is a known POI icon', () => {
    render(
      <PoiHoverPreview
        name="Cafe Picolo"
        category="cafe"
        screenX={0}
        screenY={0}
      />,
    );

    const card = screen.getByTestId('poi-hover-preview');
    const img = card.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('/sprites/source/cafe.svg');
    expect(card.querySelector('[data-testid="poi-hover-badge"]')).toBeTruthy();
  });

  it('falls back to a dot marker when the category is unknown', () => {
    render(
      <PoiHoverPreview
        name="Unnamed Feature"
        category="not_a_real_category"
        screenX={0}
        screenY={0}
      />,
    );

    const card = screen.getByTestId('poi-hover-preview');
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('span[aria-hidden="true"]')).toBeTruthy();
  });

  it('renders the full address block when multiple lines are provided', () => {
    render(
      <PoiHoverPreview
        name="CVS Pharmacy"
        categoryLabel="Pharmacy"
        addressLines={['989 Boston Post Rd', 'Milford, CT 06460']}
        category="pharmacy"
        screenX={0}
        screenY={0}
      />,
    );

    expect(screen.getByText('Pharmacy')).toBeTruthy();
    expect(screen.getByText('989 Boston Post Rd')).toBeTruthy();
    expect(screen.getByText('Milford, CT 06460')).toBeTruthy();
  });

  it('shows Directions + Share buttons when handlers are provided', () => {
    const onDirections = vi.fn();
    const onShare = vi.fn();
    render(
      <PoiHoverPreview
        name="CVS Pharmacy"
        categoryLabel="Pharmacy"
        addressLines={['989 Boston Post Rd', 'Milford, CT 06460']}
        category="pharmacy"
        screenX={0}
        screenY={0}
        onDirections={onDirections}
        onShare={onShare}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /directions/i }));
    expect(onDirections).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(onShare).toHaveBeenCalledOnce();
  });

  it('omits action bar when no handlers are provided', () => {
    render(
      <PoiHoverPreview
        name="Quiet Spot"
        screenX={0}
        screenY={0}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders only the business name when no detail lines exist', () => {
    render(
      <PoiHoverPreview
        name="Quiet Spot"
        categoryLabel="Park"
        screenX={0}
        screenY={0}
      />,
    );

    expect(screen.getByText('Quiet Spot')).toBeTruthy();
    expect(screen.getByText('Park')).toBeTruthy();
    expect(screen.queryByText(/westport|milford|address/i)).toBeNull();
  });
});
