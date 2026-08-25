import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const base = process.env.ASTRO_BASE ?? '/docs';

export default defineConfig({
  site: process.env.ASTRO_SITE,
  base,
  // The YouTube app became the multi-source Videos app; keep old links working.
  // (Redirect destinations are emitted verbatim, so the base must be baked in.)
  redirects: { '/user/features/youtube': `${base}/user/features/videos` },
  integrations: [
    starlight({
      title: 'MaiPai Home',
      tagline: 'Your family. Your data. Your rules.',
      logo: { src: './src/assets/brand.svg', alt: 'MaiPai Home' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      social: {
        github: 'https://github.com/getmaipai/home',
      },
      head: [
        {
          // Hide the site header only when these docs are embedded in the app's
          // iframe. On the standalone GitHub Pages site the header stays visible
          // so the title, search, and GitHub link are available. Runs before
          // paint to avoid a flash of the header inside the app.
          tag: 'script',
          content: `
            if (window.self !== window.top) {
              document.documentElement.setAttribute('data-embed', '');
            }
          `,
        },
        {
          tag: 'script',
          content: `
            if (!localStorage.getItem('starlight-theme')) {
              document.documentElement.setAttribute('data-theme', 'dark');
            }
          `,
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: 'anonymous',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700;1,14..32,400&family=JetBrains+Mono:wght@400;500&display=swap',
          },
        },
      ],
      expressiveCode: {
        themes: ['one-dark-pro'],
        styleOverrides: {
          borderRadius: '0.5rem',
          codePaddingBlock: '1rem',
          codePaddingInline: '1.25rem',
          frames: { shadowColor: 'transparent' },
        },
      },
      sidebar: [
        { label: 'Start here', items: ['user/welcome', 'user/getting-started', 'user/update'] },
        { label: 'Everyday use', items: [
          'user/features/chat', 'user/features/voice', 'user/features/companions',
          'user/features/music', 'user/features/videos', 'user/features/movies',
          'user/features/shows', 'user/features/podcasts', 'user/features/books',
          'user/features/news', 'user/features/today', 'user/features/image-generation',
          'user/features/canvas', 'user/features/maps', 'user/features/desktop',
        ] },
        { label: 'More apps & tools', collapsed: true, items: [
          'user/features/app-store', 'user/features/bookmarks', 'user/features/clips',
          'user/features/coding', 'user/features/converter', 'user/features/drop',
          'user/features/home-inventory', 'user/features/notifications',
          'user/features/recognition', 'user/features/reference',
          'user/features/reverse-lookup', 'user/features/shopping',
          'user/features/skills', 'user/features/speed-test', 'user/features/time',
          'user/features/tools', 'user/features/voice-memos',
        ] },
        { label: 'Connect your home', collapsed: true, items: [
          'user/features/home-assistant', 'user/features/frigate', 'user/features/plex',
        ] },
        { label: 'Your family', items: ['user/admin'] },
        { label: 'Privacy & safety', items: ['user/privacy'] },
        { label: 'Fix a problem', items: ['user/fix-a-problem'] },
        {
          label: 'For tinkerers & developers',
          collapsed: true,
          autogenerate: { directory: 'dev' },
        },
      ],
    }),
  ],
});
