import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PoiHoverPreview from './PoiHoverPreview';

describe('PoiHoverPreview', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the name and subtitle at the given screen coords', () => {
    render(
      <PoiHoverPreview
        name="Bridgewater Associates"
        subtitle="One Nyala Farms Rd, Westport, CT"
        category="office"
        screenX={120}
        screenY={48}
      />,
    );

    expect(screen.getByText('Bridgewater Associates')).toBeTruthy();
    expect(
      screen.getByText('One Nyala Farms Rd, Westport, CT'),
    ).toBeTruthy();

    const card = screen.getByTestId('poi-hover-preview');
    expect(card.style.position).toBe('fixed');
    expect(card.style.left).toBe('132px');
    expect(card.style.top).toBe('60px');
    expect(card.getAttribute('role')).toBe('tooltip');
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
});
