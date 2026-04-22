import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ChatWindow from "../../ChatWindow";
import FindInChatBar from "../FindInChatBar";
import SearchDialog from "../SearchDialog";

const results = [
  {
    message_id: 11,
    session_id: 7,
    session_title: "Jedi Notes",
    role: "assistant",
    created_at: "2026-04-21T12:00:00Z",
    snippet: "Luke reviewed the [hyperdrive] chart.",
  },
];

describe("FindInChatBar", () => {
  it("renders, lets enter select the active result, and esc closes", () => {
    const onClose = vi.fn();
    const onSelectResult = vi.fn();

    render(
      <FindInChatBar
        open
        query="hyperdrive"
        results={results}
        activeIndex={0}
        onQueryChange={() => undefined}
        onClose={onClose}
        onNext={() => undefined}
        onPrev={() => undefined}
        onSelectResult={onSelectResult}
      />,
    );

    const input = screen.getByLabelText("Find in this chat");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectResult).toHaveBeenCalledWith(results[0]);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ChatWindow search shortcuts", () => {
  it("opens the find bar from Ctrl+F", () => {
    const onOpenFind = vi.fn();

    render(
      <ChatWindow
        messages={[
          {
            role: "assistant",
            content: "Luke reviewed the hyperdrive chart.",
            timestamp: "2026-04-21T12:00:00Z",
            messageId: 11,
          },
        ]}
        onOpenFind={onOpenFind}
      />,
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(onOpenFind).toHaveBeenCalled();
    expect(screen.getByLabelText("Find in this chat")).toBeTruthy();
  });
});

describe("SearchDialog", () => {
  it("renders results and selects a row", () => {
    const onSelectResult = vi.fn();

    render(
      <SearchDialog
        open
        onOpenChange={() => undefined}
        query="hyperdrive"
        results={results}
        onQueryChange={() => undefined}
        onSelectResult={onSelectResult}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /jedi notes/i }));
    expect(onSelectResult).toHaveBeenCalledWith(results[0]);
  });
});
