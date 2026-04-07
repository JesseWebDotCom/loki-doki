/**
 * MemoryPage tests — pin the PR3 tabbed layout against mocked APIs.
 *
 * Plain @testing-library/react matchers — no jest-dom in this repo.
 * ``getByText`` / ``getByTestId`` already throw on missing nodes, so
 * the assertions are just "did this render at all".
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>(
    "../../lib/api",
  );
  return {
    ...actual,
    getPeople: vi.fn(),
    getRelationships: vi.fn(),
    getFacts: vi.fn(),
    getFactConflicts: vi.fn(),
    searchFacts: vi.fn(),
  };
});

vi.mock("../../components/sidebar/Sidebar", () => ({
  default: () => <div data-testid="sidebar-stub" />,
}));

import * as api from "../../lib/api";
import MemoryPage from "../MemoryPage";

const mocked = api as unknown as {
  getPeople: ReturnType<typeof vi.fn>;
  getRelationships: ReturnType<typeof vi.fn>;
  getFacts: ReturnType<typeof vi.fn>;
  getFactConflicts: ReturnType<typeof vi.fn>;
  searchFacts: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mocked.getPeople.mockResolvedValue({
    people: [
      { id: 1, name: "Mark", fact_count: 2 },
      { id: 2, name: "Mira", fact_count: 1 },
    ],
  });
  mocked.getRelationships.mockResolvedValue({
    relationships: [
      { id: 10, relation: "brother", confidence: 0.7, person_id: 1, person_name: "Mark" },
      { id: 11, relation: "daughter", confidence: 0.6, person_id: 2, person_name: "Mira" },
    ],
  });
  mocked.getFacts.mockResolvedValue({
    facts: [
      { id: 100, subject: "self", predicate: "occupation", value: "electrician", category: "general", confidence: 0.6, fact: "electrician" },
      { id: 101, subject: "mark", predicate: "location", value: "Denver", category: "general", confidence: 0.7, fact: "Denver" },
    ],
  });
  mocked.getFactConflicts.mockResolvedValue({ conflicts: [] });
  mocked.searchFacts.mockResolvedValue({ query: "", results: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <MemoryPage />
    </MemoryRouter>,
  );
}

describe("MemoryPage", () => {
  it("opens on the You tab with self facts visible", async () => {
    renderPage();
    // Self fact ('electrician') is visible immediately because You is
    // the default tab.
    expect(await screen.findByText(/electrician/)).toBeTruthy();
    // Section header inside the FactsTab grouping (distinct from the
    // page header's "X about you" count line).
    expect(screen.getByRole("heading", { name: /About you/i })).toBeTruthy();
  });

  it("switches to People tab and renders one card per person", async () => {
    renderPage();
    await screen.findByText(/electrician/);
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));
    expect(await screen.findByTestId("people-list")).toBeTruthy();
    expect(screen.getByText("Mark")).toBeTruthy();
    expect(screen.getByText("Mira")).toBeTruthy();
  });

  it("expands a person card to reveal their nested facts and relationship", async () => {
    renderPage();
    await screen.findByText(/electrician/);
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));
    await screen.findByText("Mark");
    // Relationship badge renders on the collapsed card.
    expect(screen.getByText(/brother/i)).toBeTruthy();
    // Mark's nested fact is hidden until expanded.
    expect(screen.queryByText(/Denver/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false, name: /Mark/ }));
    expect(await screen.findByText(/Denver/)).toBeTruthy();
  });

  it("renders the conflicts callout on the You tab when self conflicts exist", async () => {
    mocked.getFactConflicts.mockResolvedValueOnce({
      conflicts: [
        {
          subject: "self",
          predicate: "favorite_color",
          candidates: [
            { id: 1, subject: "self", predicate: "favorite_color", value: "blue", confidence: 0.6 },
            { id: 2, subject: "self", predicate: "favorite_color", value: "green", confidence: 0.6 },
          ],
        },
      ],
    });
    renderPage();
    expect(await screen.findByTestId("conflicts-callout")).toBeTruthy();
    expect(screen.getByRole("button", { name: "blue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "green" })).toBeTruthy();
  });

  it("debounces fact search and only calls searchFacts after typing settles", async () => {
    renderPage();
    await screen.findByText(/electrician/);
    const input = await screen.findByLabelText("search facts");
    fireEvent.change(input, { target: { value: "ras" } });
    fireEvent.change(input, { target: { value: "rasp" } });
    fireEvent.change(input, { target: { value: "raspberry" } });
    // No call should have happened synchronously — that's the debounce.
    expect(mocked.searchFacts).not.toHaveBeenCalled();
    await waitFor(
      () => expect(mocked.searchFacts).toHaveBeenCalledTimes(1),
      { timeout: 1000 },
    );
    expect(mocked.searchFacts).toHaveBeenLastCalledWith("raspberry");
  });
});

describe("ConfidenceBar", () => {
  it("fills width proportional to value", async () => {
    const { ConfidenceBar } = await import("../../components/memory/ConfidenceBar");
    render(<ConfidenceBar value={0.42} />);
    const fill = screen.getByTestId("confidence-fill") as HTMLDivElement;
    expect(fill.style.width).toBe("42%");
  });

  it("clamps out-of-range values", async () => {
    const { ConfidenceBar } = await import("../../components/memory/ConfidenceBar");
    render(<ConfidenceBar value={5} />);
    const fill = screen.getByTestId("confidence-fill") as HTMLDivElement;
    expect(fill.style.width).toBe("100%");
  });
});
