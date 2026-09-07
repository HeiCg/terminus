// A single shared clock so every relative timestamp in the UI ticks off one
// interval instead of each row owning a timer. `start` is called once from
// main.ts and returns a stop function; the tick is a plain method (a side effect
// in an interval callback, not a reactive effect), keeping the UI within the
// no-reactive-effect rule.
export class Clock {
  now = $state(Date.now());

  start(intervalMs = 1000): () => void {
    const id = setInterval(() => { this.now = Date.now(); }, intervalMs);
    return () => clearInterval(id);
  }
}
