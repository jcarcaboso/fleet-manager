import { reactive } from 'vue';

/**
 * The shared tooltip (the old `#tip`). Any element with a `data-tip="value|label\nextra row"` attribute shows it on
 * pointer hover and keyboard focus; `installTooltipListeners` (called by `AppShell`) wires that up with delegated listeners.
 * Charts call `showTip` themselves. The text is always rendered as text, never as markup.
 */
export interface TooltipState {
  visible: boolean;
  head: string;
  label: string;
  rows: string[];
  /** Anchor point in viewport pixels: the middle of the element's top edge. */
  x: number;
  y: number;
}

export const tooltip: TooltipState = reactive({ visible: false, head: '', label: '', rows: [], x: 0, y: 0 });

/** Parses "value|label" plus extra rows split on newlines. */
export function parseTip(text: string): { head: string; label: string; rows: string[] } {
  const [first = '', ...rows] = String(text).split('\n');
  const [head = '', label = ''] = first.includes('|') ? first.split('|') : [first, ''];
  return { head, label, rows };
}

export function showTip(text: string, x: number, y: number): void {
  const parsed = parseTip(text);
  tooltip.head = parsed.head;
  tooltip.label = parsed.label;
  tooltip.rows = parsed.rows;
  tooltip.x = x;
  tooltip.y = y;
  tooltip.visible = true;
}
export function hideTip(): void {
  tooltip.visible = false;
}
export function tipFor(el: Element): void {
  const text = (el as HTMLElement).dataset?.tip;
  if (!text) return;
  const r = el.getBoundingClientRect();
  showTip(text, r.left + r.width / 2, r.top);
}

/** Delegated listeners for `[data-tip]`. Returns the function that removes them. */
export function installTooltipListeners(doc: Document = document): () => void {
  const closest = (e: Event): Element | null => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);
  const over = (e: Event): void => {
    const t = closest(e);
    if (t) tipFor(t);
  };
  const out = (e: Event): void => {
    const t = closest(e);
    if (t && !(e instanceof PointerEvent && e.relatedTarget instanceof Node && t.contains(e.relatedTarget))) hideTip();
  };
  const win = doc.defaultView;
  doc.addEventListener('pointerover', over);
  doc.addEventListener('pointerout', out);
  doc.addEventListener('focusin', over);
  doc.addEventListener('focusout', out);
  win?.addEventListener('scroll', hideTip, { passive: true });
  return () => {
    doc.removeEventListener('pointerover', over);
    doc.removeEventListener('pointerout', out);
    doc.removeEventListener('focusin', over);
    doc.removeEventListener('focusout', out);
    win?.removeEventListener('scroll', hideTip);
    hideTip();
  };
}
