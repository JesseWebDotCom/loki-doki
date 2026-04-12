import React, { useEffect, useState } from 'react';
import { ensureCachedFavicon, getCachedFavicon, getFallbackFavicon } from './faviconCache';

interface FaviconImageProps {
  hostname: string;
  remoteUrl: string;
  className?: string;
}

const FaviconImage: React.FC<FaviconImageProps> = ({ hostname, remoteUrl, className }) => {
  const [src, setSrc] = useState(() => getCachedFavicon(hostname) ?? getFallbackFavicon(hostname));

  useEffect(() => {
    let cancelled = false;
    setSrc(getCachedFavicon(hostname) ?? getFallbackFavicon(hostname));

    void ensureCachedFavicon(hostname, remoteUrl).then((resolved) => {
      if (!cancelled) setSrc(resolved);
    });

    return () => {
      cancelled = true;
    };
  }, [hostname, remoteUrl]);

  return <img src={src} alt="" className={className} loading="lazy" />;
};

export default FaviconImage;
