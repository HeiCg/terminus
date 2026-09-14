// A crash in one handler must not take the whole collector down mid-session, so
// `uncaughtException`/`unhandledRejection` are logged and swallowed. But a tight
// crash loop — a handler throwing on every event — burns CPU and produces nothing;
// a clean stop is better. This guard counts crashes in a sliding window and trips
// once too many land too close together. Pure and clock-injectable so the trip
// logic is unit-testable without spawning the process or throwing real errors.
export function createCrashGuard(opts: {
  threshold: number;
  windowMs?: number;
  now?: () => number;
  onTrip: (count: number) => void;
}): { record(): void } {
  const threshold = Math.max(1, Math.floor(opts.threshold));
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let times: number[] = [];
  let tripped = false;
  return {
    record(): void {
      const t = now();
      times.push(t);
      // Drop anything older than the window so only a genuine burst trips the guard.
      times = times.filter((x) => t - x < windowMs);
      // Trip at most once: shutdown is already in flight after the first trip.
      if (!tripped && times.length >= threshold) {
        tripped = true;
        opts.onTrip(times.length);
      }
    },
  };
}
