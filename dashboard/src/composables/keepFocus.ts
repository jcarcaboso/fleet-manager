/**
 * A button that is disabled while its action runs (Sync repository, Refresh, Retry now, Save alias …) loses keyboard focus when the browser
 * disables it: Chromium moves focus to <body>, and it stays there when the button is enabled again. The old dashboard repainted the page and
 * put focus back by selector. Here one observer does it for every button: when the focused element becomes `disabled`, it is remembered; when
 * it is enabled again and nothing else has focus, it gets the focus back. Any key press or pointer press in between means the user moved on, so
 * nothing is restored. Installed once by `AppShell`; returns the function that removes it.
 */
export function installKeepFocus(doc: Document = document): () => void {
  let held: HTMLElement | null = null;
  const forget = (): void => { held = null; };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const el = record.target;
      if (!(el instanceof HTMLElement)) continue;
      if (el.hasAttribute('disabled')) {
        if (el === doc.activeElement) held = el;
      } else if (el === held) {
        held = null;
        const active = doc.activeElement;
        if (el.isConnected && (!active || active === doc.body)) el.focus({ preventScroll: true });
      }
    }
  });
  observer.observe(doc.body, { attributes: true, attributeFilter: ['disabled'], subtree: true });
  doc.addEventListener('keydown', forget, true);
  doc.addEventListener('pointerdown', forget, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener('keydown', forget, true);
    doc.removeEventListener('pointerdown', forget, true);
    held = null;
  };
}
