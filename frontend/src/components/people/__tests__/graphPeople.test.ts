import { describe, expect, it } from "vitest";

import { buildGraphPeopleMap } from "../graphPeople";

describe("buildGraphPeopleMap", () => {
  it("creates selectable placeholder people from edges", () => {
    const peopleMap = buildGraphPeopleMap(
      [{ id: 1, name: "Jesse" }],
      [
        {
          id: 1,
          from_person_id: 2,
          from_person_name: "Mira",
          to_person_id: 1,
          to_person_name: "Jesse",
          edge_type: "spouse",
          confidence: 1,
        },
      ],
    );

    expect(peopleMap.get(2)?.name).toBe("Mira");
  });
});
