import { useEffect, useMemo, useRef } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";

import { isArtifactRpcMessage, type ArtifactRpcMessage } from "@/lib/artifact-rpc";

import {
  ARTIFACT_CSP,
  isArtifactContentWithinLimit,
} from "./csp";

type SandboxedFrameProps = {
  title: string;
  content: string;
  onRpc?: (message: ArtifactRpcMessage) => void;
};

function composeSrcDoc(title: string, content: string): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}" />`,
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    content,
    "</body>",
    "</html>",
  ].join("");
}

export default function SandboxedFrame({
  title,
  content,
  onRpc,
}: SandboxedFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const srcDoc = useMemo(() => composeSrcDoc(title, content), [content, title]);
  const withinLimit = isArtifactContentWithinLimit(content);

  useEffect(() => {
    if (!onRpc) {
      return undefined;
    }
    const handleRpc = onRpc;

    function handleMessage(event: MessageEvent) {
      const childWindow = frameRef.current?.contentWindow;
      if (!childWindow || event.source !== childWindow || event.origin !== "null") {
        return;
      }
      if (!isArtifactRpcMessage(event.data)) {
        console.warn("Dropping unknown artifact RPC message", event.data);
        return;
      }
      handleRpc(event.data);
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onRpc]);

  return (
    <Card
      data-slot="artifact-sandbox"
      className="mx-auto w-full max-w-[800px] overflow-hidden"
    >
      <CardHeader className="pb-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </CardHeader>
      <CardContent>
        {withinLimit ? (
          <iframe
            ref={frameRef}
            title={title}
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            className="h-[600px] w-full max-w-full rounded-xl border border-border/40 bg-background"
          />
        ) : (
          <div
            data-slot="artifact-size-guard"
            className="rounded-xl border border-border/40 bg-muted/30 p-4 text-sm text-muted-foreground"
          >
            Artifact content exceeds the local sandbox size cap.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
