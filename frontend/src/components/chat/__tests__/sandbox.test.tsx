import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ARTIFACT_CSP } from "../artifact/csp";
import { isArtifactRpcMessage } from "../../../lib/artifact-rpc";
import SandboxedFrame from "../artifact/SandboxedFrame";

afterEach(() => {
  cleanup();
});

describe("SandboxedFrame", () => {
  it("renders an iframe with the canonical CSP and only allow-scripts sandboxing", () => {
    const { container } = render(
      <SandboxedFrame title="Luke Artifact" content="<h1>Hello</h1>" />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");

    const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain(ARTIFACT_CSP);
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain("<h1>Hello</h1>");
  });

  it("drops malformed or unsolicited postMessage events", () => {
    const onRpc = vi.fn();
    render(
      <SandboxedFrame
        title="Leia Artifact"
        content="<p>Test</p>"
        onRpc={onRpc}
      />,
    );

    fireEvent(
      window,
      new MessageEvent("message", {
        data: { kind: "delete", payload: "nope" },
        source: window,
      }),
    );

    fireEvent(
      window,
      new MessageEvent("message", {
        data: { kind: "save", payload: "accepted shape" },
        source: window,
      }),
    );

    expect(onRpc).not.toHaveBeenCalled();
  });
});

describe("artifact-rpc", () => {
  it("accepts only save/export message kinds", () => {
    expect(isArtifactRpcMessage({ kind: "save", payload: "<svg />" })).toBe(true);
    expect(isArtifactRpcMessage({ kind: "export", format: "html" })).toBe(true);
    expect(isArtifactRpcMessage({ kind: "delete", payload: "nope" })).toBe(false);
    expect(isArtifactRpcMessage({ foo: "bar" })).toBe(false);
  });
});
