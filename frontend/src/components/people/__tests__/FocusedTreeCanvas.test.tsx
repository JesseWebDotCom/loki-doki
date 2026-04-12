import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FocusedTreeCanvas } from "../FocusedTreeCanvas";

vi.mock("../ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("FocusedTreeCanvas", () => {
  it("renders relatives that only exist in the edge payload", () => {
    render(
      <FocusedTreeCanvas
        people={[
          { id: 1, name: "Jesse" },
          { id: 4, name: "Ben" },
        ]}
        selectedPerson={{ id: 1, name: "Jesse" }}
        edges={[
          {
            id: 1,
            from_person_id: 1,
            from_person_name: "Jesse",
            to_person_id: 2,
            to_person_name: "Mira",
            edge_type: "spouse",
            confidence: 1,
          },
          {
            id: 2,
            from_person_id: 3,
            from_person_name: "Luke",
            to_person_id: 1,
            to_person_name: "Jesse",
            edge_type: "parent",
            confidence: 1,
          },
          {
            id: 3,
            from_person_id: 1,
            from_person_name: "Jesse",
            to_person_id: 4,
            to_person_name: "Ben",
            edge_type: "parent",
            confidence: 1,
          },
        ]}
        onSelectPerson={vi.fn()}
        onClearFocus={vi.fn()}
        currentUserPersonId={1}
      />,
    );

    expect((screen.getAllByText("Mira")).length).toBeGreaterThan(0);
    expect((screen.getAllByText("Luke")).length).toBeGreaterThan(0);
    expect((screen.getAllByText("Ben")).length).toBeGreaterThan(0);
  });

  it("renders separate ancestor branches for the focused person and spouse", () => {
    render(
      <FocusedTreeCanvas
        people={[{ id: 1, name: "Jesse" }]}
        selectedPerson={{ id: 1, name: "Jesse" }}
        edges={[
          { id: 1, from_person_id: 1, from_person_name: "Jesse", to_person_id: 2, to_person_name: "Mira", edge_type: "spouse", confidence: 1 },
          { id: 2, from_person_id: 3, from_person_name: "Luke", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 1 },
          { id: 3, from_person_id: 4, from_person_name: "Leia", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 1 },
          { id: 4, from_person_id: 5, from_person_name: "Han", to_person_id: 2, to_person_name: "Mira", edge_type: "parent", confidence: 1 },
          { id: 5, from_person_id: 6, from_person_name: "Padme", to_person_id: 2, to_person_name: "Mira", edge_type: "parent", confidence: 1 },
          { id: 6, from_person_id: 7, from_person_name: "Anakin", to_person_id: 3, to_person_name: "Luke", edge_type: "parent", confidence: 1 },
          { id: 7, from_person_id: 8, from_person_name: "Obi-Wan", to_person_id: 5, to_person_name: "Han", edge_type: "parent", confidence: 1 },
        ]}
        onSelectPerson={vi.fn()}
        onClearFocus={vi.fn()}
        currentUserPersonId={1}
      />,
    );

    expect((screen.getAllByText("Luke")).length).toBeGreaterThan(0);
    expect((screen.getAllByText("Leia")).length).toBeGreaterThan(0);
    expect((screen.getAllByText("Han")).length).toBeGreaterThan(0);
    expect((screen.getAllByText("Padme")).length).toBeGreaterThan(0);
    expect((screen.getAllByText("Anakin")).length).toBeGreaterThan(0);
    expect((screen.getAllByText("Obi-Wan")).length).toBeGreaterThan(0);
  });

  it("keeps both spouse branches laid out side by side without wrapping", () => {
    const { container } = render(
      <FocusedTreeCanvas
        people={[{ id: 1, name: "Jesse" }]}
        selectedPerson={{ id: 1, name: "Jesse" }}
        edges={[
          { id: 1, from_person_id: 1, from_person_name: "Jesse", to_person_id: 2, to_person_name: "Mira", edge_type: "spouse", confidence: 1 },
          { id: 2, from_person_id: 3, from_person_name: "Luke", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 1 },
          { id: 3, from_person_id: 4, from_person_name: "Leia", to_person_id: 1, to_person_name: "Jesse", edge_type: "parent", confidence: 1 },
          { id: 4, from_person_id: 5, from_person_name: "Han", to_person_id: 2, to_person_name: "Mira", edge_type: "parent", confidence: 1 },
          { id: 5, from_person_id: 6, from_person_name: "Padme", to_person_id: 2, to_person_name: "Mira", edge_type: "parent", confidence: 1 },
        ]}
        onSelectPerson={vi.fn()}
        onClearFocus={vi.fn()}
        currentUserPersonId={1}
      />,
    );

    expect(container.querySelector(".min-w-\\[24rem\\]")).toBeTruthy();
    expect(container.querySelector(".flex-nowrap")).toBeTruthy();
  });
});
