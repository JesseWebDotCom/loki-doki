import { Copy, Download, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ArtifactExportMenuProps {
  title: string;
  kind: string;
  content: string;
}

function sanitizedBaseName(title: string): string {
  const trimmed = title.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function saveBlob(filename: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function ArtifactExportMenu({
  title,
  kind,
  content,
}: ArtifactExportMenuProps) {
  const baseName = sanitizedBaseName(title);
  const extension = kind === "svg" ? "svg" : "html";
  const mimeType = extension === "svg" ? "image/svg+xml" : "text/html";
  const showNativeFormat = extension !== "html";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label="Export artifact">
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            void navigator.clipboard.writeText(content);
          }}
        >
          <Copy size={14} className="mr-2" />
          Copy HTML
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => saveBlob(`${baseName}.html`, content, "text/html")}
        >
          <Download size={14} className="mr-2" />
          Save as .html
        </DropdownMenuItem>
        {showNativeFormat ? (
          <DropdownMenuItem
            onSelect={() => saveBlob(`${baseName}.${extension}`, content, mimeType)}
          >
            <Download size={14} className="mr-2" />
            {`Save as .${extension}`}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
