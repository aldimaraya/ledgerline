/**
 * Pull-to-refresh for a touch surface.
 *
 * Only engages when the container is already scrolled to the top, so it never fights the
 * list. Deliberately not a library: the whole behaviour is thirty lines and a dependency
 * here would outweigh it.
 */

import { useEffect, useRef, useState } from 'react';

const TRIGGER_PX = 64;
const MAX_PULL = 96;

export function usePullToRefresh(onRefresh: () => void | Promise<void>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pull, setPull] = useState(0);
  const startY = useRef<number | null>(null);
  // A ref, not state: the touch handlers close over this and must see the live value.
  const busy = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onStart = (e: TouchEvent) => {
      if (el.scrollTop > 0 || busy.current) return;
      startY.current = e.touches[0]!.clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const delta = e.touches[0]!.clientY - startY.current;
      if (delta <= 0) {
        startY.current = null;
        setPull(0);
        return;
      }
      // Resistance, so the sheet does not track the finger one-to-one.
      setPull(Math.min(delta * 0.45, MAX_PULL));
    };

    const onEnd = async () => {
      if (startY.current === null) return;
      const shouldRefresh = pull >= TRIGGER_PX * 0.45;
      startY.current = null;
      setPull(0);
      if (!shouldRefresh || busy.current) return;
      busy.current = true;
      try {
        await onRefresh();
      } finally {
        busy.current = false;
      }
    };

    // passive: the handler never calls preventDefault, and saying so keeps scrolling
    // off the main thread.
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [onRefresh, pull]);

  return { ref, pull, armed: pull >= TRIGGER_PX * 0.45 };
}
