import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: process.env.ASTRO_SITE,
  base: process.env.ASTRO_BASE ?? '/docs',
  integrations: [
    starlight({
      title: 'Loki Doki',
      tagline: 'Your family. Your data. Your rules.',
      logo: { src: './src/assets/brand.svg', alt: 'LokiDoki' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      social: {
        github: 'https://github.com/JesseWebDotCom/loki-doki',
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
        {
          label: 'User Guide',
          autogenerate: { directory: 'user' },
        },
        {
          label: 'Developer Guide',
          autogenerate: { directory: 'dev' },
        },
      ],
    }),
  ],
});
