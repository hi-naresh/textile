import type { MetadataRoute } from 'next';

// Installable on phones ("Add to Home Screen" / "Install app"): opens full-screen and keeps its
// sign-in cookies, so people stay signed in for weeks.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Textile operations',
    short_name: 'Textile',
    description: 'Stock, job cards and photo capture for the owner, supervisors and workers',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F3F0E8',
    theme_color: '#F3F0E8',
    icons: [
      { src: '/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
      { src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' },
    ],
  };
}
