import type { SourceInfo } from '../../lib/api';

export interface SourcePresentation {
  title: string;
  sourceName: string;
  label: string;
  hostname: string;
  faviconUrl: string;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleCaseSegment(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function hostnameLabel(hostname: string): string {
  const clean = hostname.replace(/^www\./i, '');
  const [first] = clean.split('.');
  return titleCaseSegment(first || clean || 'Source');
}

function inferSourceName(rawTitle: string, hostname: string): string {
  const dashParts = rawTitle.split(/\s[—-]\s/).map((part) => part.trim()).filter(Boolean);
  if (dashParts.length > 1) {
    return dashParts[dashParts.length - 1];
  }
  return hostnameLabel(hostname);
}

function stripTrailingSourceName(rawTitle: string, sourceName: string): string {
  const normalizedTitle = rawTitle.trim();
  const dashParts = normalizedTitle.split(/\s([—-])\s/);
  if (dashParts.length < 3) return normalizedTitle;
  const lastSeparator = normalizedTitle.match(/\s[—-]\s(?=[^—-]*$)/);
  if (!lastSeparator) return normalizedTitle;

  const idx = normalizedTitle.lastIndexOf(lastSeparator[0]);
  const left = normalizedTitle.slice(0, idx).trim();
  const right = normalizedTitle.slice(idx + lastSeparator[0].length).trim();
  if (!left || !right) return normalizedTitle;

  const normalizedRight = normalizeText(right);
  const normalizedSource = normalizeText(sourceName);
  if (
    normalizedRight === normalizedSource ||
    normalizedRight.includes(normalizedSource) ||
    normalizedSource.includes(normalizedRight)
  ) {
    return left;
  }
  return normalizedTitle;
}

export function getSourcePresentation(source: SourceInfo): SourcePresentation {
  let hostname = 'source.local';
  try {
    hostname = new URL(source.url).hostname;
  } catch {
    // Keep the fallback hostname for malformed URLs; the UI still renders.
  }

  const rawTitle = source.title?.trim() || source.url;
  const sourceName = inferSourceName(rawTitle, hostname);
  const title = stripTrailingSourceName(rawTitle, sourceName);
  const label = normalizeText(title) === normalizeText(sourceName)
    ? title
    : `${title} - ${sourceName}`;

  return {
    title,
    sourceName,
    label,
    hostname: hostname.replace(/^www\./i, ''),
    faviconUrl: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`,
  };
}
