import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    getPeopleGraph: vi.fn(),
    getStructuredPersonDetail: vi.fn(),
    getProfilePhotoOptions: vi.fn(),
    getReconcileCandidates: vi.fn(),
    mergeStructuredPeople: vi.fn(),
  };
});

vi.mock("../../components/sidebar/Sidebar", () => ({
  default: () => <div data-testid="sidebar-stub" />,
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    currentUser: { id: 1, username: "jesse", role: "admin", linked_person_id: 1 },
    refresh: vi.fn(),
  }),
}));

import * as api from "../../lib/api";
import PeoplePage from "../PeoplePage";

const mocked = api as unknown as {
  getPeopleGraph: ReturnType<typeof vi.fn>;
  getStructuredPersonDetail: ReturnType<typeof vi.fn>;
  getProfilePhotoOptions: ReturnType<typeof vi.fn>;
  getReconcileCandidates: ReturnType<typeof vi.fn>;
  mergeStructuredPeople: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mocked.getPeopleGraph.mockResolvedValue({
    people: [
      { id: 1, name: "Jesse", bucket: "family", relationship_state: "active", interaction_preference: "normal" },
      { id: 2, name: "Mira", bucket: "family", relationship_state: "former", interaction_preference: "avoid" },
    ],
    edges: [{ id: 1, from_person_id: 1, from_person_name: "Jesse", to_person_id: 2, to_person_name: "Mira", edge_type: "spouse", confidence: 0.8 }],
  });
  mocked.getStructuredPersonDetail.mockResolvedValue({
    person: { id: 1, name: "Jesse", bucket: "family", relationship_state: "active", interaction_preference: "normal" },
    media: [],
    events: [{ id: 1, event_type: "birthday", event_date: "1988-05-01" }],
    facts: [{ id: 1, predicate: "likes", value: "movies" }],
    edges: [{ id: 1, from_person_id: 1, from_person_name: "Jesse", to_person_id: 2, to_person_name: "Mira", edge_type: "spouse", confidence: 0.8 }],
  });
  mocked.getProfilePhotoOptions.mockResolvedValue({ options: [] });
  mocked.getReconcileCandidates.mockResolvedValue({
    groups: [
      {
        label: "Luke",
        suggested_target_id: 1,
        suggestion_reason: "has the richest existing profile",
        candidates: [
          {
            id: 1,
            name: "Luke",
            owner_user_id: 1,
            fact_count: 4,
            event_count: 1,
            media_count: 0,
            edge_count: 3,
          },
          {
            id: 2,
            name: "Luke",
            owner_user_id: 1,
            fact_count: 1,
            event_count: 0,
            media_count: 0,
            edge_count: 1,
          },
        ],
      },
    ],
  });
  mocked.mergeStructuredPeople.mockResolvedValue({ ok: true });
  vi.spyOn(window, "fetch").mockImplementation(async () => new Response(JSON.stringify({ users: [] }), { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("PeoplePage", () => {
  it("renders tree view with required overlay filters", async () => {
    render(
      <MemoryRouter>
        <PeoplePage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("people-tree-view")).toBeTruthy();
    expect(screen.getByDisplayValue("All relationship states")).toBeTruthy();
    expect(screen.getByDisplayValue("All interaction prefs")).toBeTruthy();
    expect(await screen.findByDisplayValue("Jesse")).toBeTruthy();
    expect(screen.getByRole("button", { name: /jump to me/i })).toBeTruthy();
  });

  it("switches to list view and shows graph people rows", async () => {
    render(
      <MemoryRouter>
        <PeoplePage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /list/i }));
    expect(await screen.findByText("Mira")).toBeTruthy();
    expect(screen.getByText("former")).toBeTruthy();
  });

  it("opens a side-by-side reconciliation review dialog", async () => {
    render(
      <MemoryRouter>
        <PeoplePage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /imports/i }));
    fireEvent.click(await screen.findByRole("button", { name: /review merge/i }));
    expect(await screen.findByText("Review duplicate merge")).toBeTruthy();
    expect(screen.getAllByText(/Suggested survivor:/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /merge into luke/i })).toBeTruthy();
  });
});
