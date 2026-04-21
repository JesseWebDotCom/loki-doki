import { describe, expect, it, vi } from 'vitest';
import {
  dedupeNearby,
  fitMapToCoords,
  getFitCoordsAction,
} from './fit-coords';

describe('fit-coords', () => {
  it('dedupes nearby consecutive coordinates', () => {
    expect(
      dedupeNearby([
        [-73.0, 41.0],
        [-73.0, 41.0],
        [-73.0000004, 41.0000004],
        [-73.1, 41.1],
      ]),
    ).toEqual([
      [-73.0, 41.0],
      [-73.1, 41.1],
    ]);
  });

  it('falls back to fly for a single distinct coordinate', () => {
    expect(
      getFitCoordsAction([
        [-73.06, 41.22],
        [-73.0600004, 41.2200004],
      ]),
    ).toEqual({
      kind: 'fly',
      center: [-73.06, 41.22],
      zoom: 17,
    });
  });

  it('calls flyTo instead of fitBounds for a degenerate slice', () => {
    const fitBounds = vi.fn();
    const flyTo = vi.fn();

    fitMapToCoords(
      { fitBounds, flyTo },
      [
        [-73.06, 41.22],
        [-73.0600004, 41.2200004],
      ],
    );

    expect(flyTo).toHaveBeenCalledWith({
      center: [-73.06, 41.22],
      zoom: 17,
      duration: 600,
    });
    expect(fitBounds).not.toHaveBeenCalled();
  });

  it('drops invalid coordinates before choosing the map action', () => {
    expect(
      getFitCoordsAction([
        [-73.06, 41.22],
        [Number.NaN, 41.23],
        [-73.0600004, 41.2200004],
        [999, 999],
      ]),
    ).toEqual({
      kind: 'fly',
      center: [-73.06, 41.22],
      zoom: 17,
    });
  });
});
