import type { Attachment } from 'svelte/attachments';

// Drag-to-resize attachment for the detail panel's LEFT edge handle. A pointerdown
// on the handle captures the pointer and, on each move, reports the width the
// panel should take — `window.innerWidth - clientX`, since the panel is anchored
// to the right — clamped to `[min, max()]` (max is a thunk so it re-reads the
// viewport on every move). Move/up listeners live on `window` so a fast drag that
// outruns the 6px handle keeps tracking; all of them are torn down on detach.
export function resizer(opts: { onResize: (px: number) => void; min: number; max: () => number }): Attachment {
  return (element) => {
    const el = element as HTMLElement;
    let dragging = false;

    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const px = window.innerWidth - e.clientX;
      opts.onResize(Math.max(opts.min, Math.min(opts.max(), px)));
    };
    const stop = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    const onDown = (e: PointerEvent): void => {
      dragging = true;
      el.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      e.preventDefault();
    };

    el.addEventListener('pointerdown', onDown);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  };
}
