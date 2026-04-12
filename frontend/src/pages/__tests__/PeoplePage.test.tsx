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
    ],
    edges: [
      { id: 1, from_person_id: 1, from_person_name: "Jesse", to_person_id: 2, to_person_name: "Mira", edge_type: "spouse", confidence: 0.8 },
      { id: 2, from_person_id: 3, from_person_name: "Luke", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 0.8 },
    ],
  });
  mocked.getStructuredPersonDetail.mockImplementation(async (id: number) => {
    if (id === 2) {
      return {
        person: { id: 2, name: "Mira", bucket: "family", relationship_state: "active", interaction_preference: "normal" },
        media: [],
        events: [],
        facts: [],
        edges: [
          { id: 1, from_person_id: 1, from_person_name: "Jesse", to_person_id: 2, to_person_name: "Mira", edge_type: "spouse", confidence: 0.8 },
          { id: 5, from_person_id: 6, from_person_name: "Padme", to_person_id: 2, to_person_name: "Mira", edge_type: "parent", confidence: 0.8 },
          { id: 6, from_person_id: 7, from_person_name: "Han", to_person_id: 2, to_person_name: "Mira", edge_type: "parent", confidence: 0.8 },
        ],
      };
    }
    if (id === 3) {
      return {
        person: { id: 3, name: "Luke", bucket: "family", relationship_state: "active", interaction_preference: "normal" },
        media: [],
        events: [],
        facts: [],
        edges: [
          { id: 2, from_person_id: 3, from_person_name: "Luke", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 0.8 },
          { id: 3, from_person_id: 3, from_person_name: "Luke", to_person_id: 4, to_person_name: "Leia", edge_type: "spouse", confidence: 0.8 },
          { id: 4, from_person_id: 5, from_person_name: "Anakin", to_person_id: 3, to_person_name: "Luke", edge_type: "parent", confidence: 0.8 },
        ],
      };
    }
    return {
      person: { id: 1, name: "Jesse", bucket: "family", relationship_state: "active", interaction_preference: "normal" },
      media: [],
      events: [{ id: 1, event_type: "birthday", event_date: "1988-05-01" }],
      facts: [{ id: 1, predicate: "likes", value: "movies" }],
      edges: [
        { id: 1, from_person_id: 1, from_person_name: "Jesse", to_person_id: 2, to_person_name: "Mira", edge_type: "spouse", confidence: 0.8 },
        { id: 2, from_person_id: 3, from_person_name: "Luke", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 0.8 },
        { id: 8, from_person_id: 8, from_person_name: "Leia Senior", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 0.8 },
      ],
    };
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
    expect((await screen.findAllByText("Mira")).length).toBeGreaterThan(0);
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("keeps focus on an edge-only relative and expands their family in tree view", async () => {
    render(
      <MemoryRouter>
        <PeoplePage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("people-tree-view")).toBeTruthy();
    fireEvent.click((await screen.findAllByText("Luke"))[0]);

    expect((await screen.findAllByText("Leia")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Anakin")).length).toBeGreaterThan(0);
  });

  it("loads spouse-side parents into the tree when the focused person has a spouse", async () => {
    render(
      <MemoryRouter>
        <PeoplePage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("people-tree-view")).toBeTruthy();
    expect((await screen.findAllByText("Padme")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Han")).length).toBeGreaterThan(0);
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
