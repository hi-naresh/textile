'use client';

// Inline script that runs during HTML parsing (before first paint).
// On the client React renders it as text/plain so it never re-executes and
// React does not warn about <script> tags; suppressHydrationWarning covers the
// type mismatch. Pattern from Next.js docs: "Preventing flash before hydration".
export default function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
