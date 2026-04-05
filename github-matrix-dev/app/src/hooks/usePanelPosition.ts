import { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react';

export type Placement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end'
  | 'right-start'
  | 'left-start';

export interface UsePanelPositionOptions {
  open: boolean;
  placement?: Placement;
  offset?: number;
  margin?: number;
  estimatedWidth?: number;
  estimatedHeight?: number;
  virtualAnchor?: { x: number; y: number } | null;
}

export interface UsePanelPositionResult {
  anchorRef: React.RefObject<HTMLElement>;
  panelRef: React.RefObject<HTMLDivElement>;
  style: React.CSSProperties;
  update: () => void;
  placement: Placement;
}

/**
 * Anchored popover positioning with flip and clamp.
 * Provide either `anchorRef` (attach to trigger) or `virtualAnchor: {x,y}`.
 */
export function usePanelPosition(opts: UsePanelPositionOptions): UsePanelPositionResult {
  const {
    open,
    placement: initialPlacement = 'bottom-end',
    offset = 4,
    margin = 8,
    estimatedWidth = 240,
    estimatedHeight = 200,
    virtualAnchor = null,
  } = opts;

  const anchorRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    top: -9999,
    left: -9999,
    visibility: 'hidden',
  });
  const [resolvedPlacement, setResolvedPlacement] = useState<Placement>(initialPlacement);

  const update = useCallback(() => {
    if (!open) return;

    // Determine anchor rect
    let anchorRect: { top: number; bottom: number; left: number; right: number; width: number; height: number } | null = null;
    if (virtualAnchor) {
      anchorRect = {
        top: virtualAnchor.y,
        bottom: virtualAnchor.y,
        left: virtualAnchor.x,
        right: virtualAnchor.x,
        width: 0,
        height: 0,
      };
    } else if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      anchorRect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    }
    if (!anchorRect) return;

    // Panel dimensions
    let panelW = estimatedWidth;
    let panelH = estimatedHeight;
    if (panelRef.current) {
      const pr = panelRef.current.getBoundingClientRect();
      if (pr.width > 0) panelW = pr.width;
      if (pr.height > 0) panelH = pr.height;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let placement = initialPlacement;

    // Flip vertical
    if (placement.startsWith('bottom')) {
      const spaceBelow = vh - anchorRect.bottom - margin;
      const spaceAbove = anchorRect.top - margin;
      if (spaceBelow < panelH && spaceAbove > spaceBelow) {
        placement = placement.replace('bottom', 'top') as Placement;
      }
    } else if (placement.startsWith('top')) {
      const spaceAbove = anchorRect.top - margin;
      const spaceBelow = vh - anchorRect.bottom - margin;
      if (spaceAbove < panelH && spaceBelow > spaceAbove) {
        placement = placement.replace('top', 'bottom') as Placement;
      }
    }

    // Compute top/left
    let top = 0;
    let left = 0;
    switch (placement) {
      case 'bottom-start':
        top = anchorRect.bottom + offset;
        left = anchorRect.left;
        break;
      case 'bottom-end':
        top = anchorRect.bottom + offset;
        left = anchorRect.right - panelW;
        break;
      case 'top-start':
        top = anchorRect.top - offset - panelH;
        left = anchorRect.left;
        break;
      case 'top-end':
        top = anchorRect.top - offset - panelH;
        left = anchorRect.right - panelW;
        break;
      case 'right-start':
        top = anchorRect.top;
        left = anchorRect.right + offset;
        break;
      case 'left-start':
        top = anchorRect.top;
        left = anchorRect.left - offset - panelW;
        break;
    }

    // Clamp inside viewport
    left = Math.max(margin, Math.min(left, vw - panelW - margin));
    top = Math.max(margin, Math.min(top, vh - panelH - margin));

    setStyle({ position: 'fixed', top, left, visibility: 'visible' });
    setResolvedPlacement(placement);
    // Depend on primitive x/y rather than the `virtualAnchor` object reference;
    // callers commonly pass inline objects which would otherwise change every
    // render and cause an infinite update loop via the layout effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPlacement, offset, margin, estimatedWidth, estimatedHeight, virtualAnchor?.x, virtualAnchor?.y]);

  // Initial measurement (pre-paint)
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' });
      return;
    }
    update();
  }, [open, update]);

  // Re-measure after panel mounts (content may expand)
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    update();
  }, [open, update]);

  // Reposition on resize/scroll
  useEffect(() => {
    if (!open) return;
    const onResize = () => update();
    const onScroll = () => update();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, update]);

  return { anchorRef, panelRef, style, update, placement: resolvedPlacement };
}
