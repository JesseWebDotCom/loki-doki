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
  const parts = hostname.replace(/^www\./i, '').split('.');
  if (parts.length >= 2) {
    // If it's something like en.wikipedia.org, parts[0] is 'en', parts[1] is 'wikipedia'
    // We want 'wikipedia'. Common subdomains to skip:
    const commonSubdomains = ['en', 'm', 'mobile', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko'];
    if (parts.length > 2 && commonSubdomains.includes(parts[0].toLowerCase())) {
      return titleCaseSegment(parts[1]);
    }
    return titleCaseSegment(parts[0]);
  }
  return titleCaseSegment(hostname || 'Source');
}

function inferSourceName(rawTitle: string, hostname: string): string {
  const hostLabel = hostnameLabel(hostname);
  const normalizedHost = normalizeText(hostLabel);

  const dashParts = rawTitle.split(/\s[—-]\s/).map((part) => part.trim()).filter(Boolean);
  if (dashParts.length > 1) {
    // Look for a part that matches the hostname-based name
    for (const part of dashParts) {
      const normalizedPart = normalizeText(part);
      if (normalizedPart.includes(normalizedHost) || normalizedHost.includes(normalizedPart)) {
        return part;
      }
    }
  }

  // Fallback to the hostname-based label if no clear match in the title
  return hostLabel;
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
