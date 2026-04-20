import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import LeftRail from "./LeftRail";
import OutOfCoverageBanner from "./OutOfCoverageBanner";
import { MANAGE_MAPS_ROUTE } from "./routes";

afterEach(() => {
  cleanup();
});

describe("maps manage-region links", () => {
  it("points the out-of-coverage CTA at the maps admin route", () => {
    render(
      <MemoryRouter>
        <OutOfCoverageBanner />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: /open settings/i }).getAttribute("href"),
    ).toBe(MANAGE_MAPS_ROUTE);
  });

  it("points the left-rail manage link at the maps admin route", () => {
    render(
      <MemoryRouter>
        <LeftRail
          active="search"
          onSelectPanel={() => {}}
          recents={[]}
          onSelectRecent={() => {}}
          onRemoveRecent={() => {}}
          collapsed={false}
          onToggleCollapsed={() => {}}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: /manage map regions/i }).getAttribute("href"),
    ).toBe(MANAGE_MAPS_ROUTE);
  });
});
