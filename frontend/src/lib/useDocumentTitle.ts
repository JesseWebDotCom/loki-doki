import { useEffect } from 'react';

/** Set `document.title` to "LokiDoki · {title}" while the component is mounted. */
export const useDocumentTitle = (title: string) => {
  useEffect(() => {
    const prev = document.title;
    document.title = `LokiDoki · ${title}`;
    return () => { document.title = prev; };
  }, [title]);
};
