/** Request-local timings: visible in browser Network tools, no user data. */
export function serverTiming() {
  const start = performance.now();
  let last = start;
  const phases: string[] = [];
  return {
    mark(name: string) { const now = performance.now(); phases.push(`${name};dur=${(now - last).toFixed(1)}`); last = now; },
    headers() { return { 'Server-Timing': [...phases, `total;dur=${(performance.now() - start).toFixed(1)}`].join(', ') }; },
  };
}
