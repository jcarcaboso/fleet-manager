import { vi } from 'vitest';

/**
 * A stand-in for IntersectionObserver (happy-dom has none). Like the real one it reports an element's state when it starts to be
 * observed and again whenever `FakeIntersectionObserver.recheck()` is called (the test "scrolls"); what counts as in range is
 * `FakeIntersectionObserver.visible`.
 */
export class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  static visible: (el: Element) => boolean = () => true;
  readonly targets = new Set<Element>();
  readonly options: IntersectionObserverInit | undefined;
  private readonly callback: IntersectionObserverCallback;
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
    queueMicrotask(() => { if (this.targets.has(el)) this.report([el]); });
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  private report(els: Element[]): void {
    this.callback(els.map(target => ({ target, isIntersecting: FakeIntersectionObserver.visible(target) }) as IntersectionObserverEntry), this as unknown as IntersectionObserver);
  }
  /** Every observed element reports its current state, as after a scroll. */
  recheck(): void {
    if (this.targets.size) this.report([...this.targets]);
  }
  static recheck(): void {
    for (const io of FakeIntersectionObserver.instances) io.recheck();
  }
  static reset(): void {
    FakeIntersectionObserver.instances = [];
    FakeIntersectionObserver.visible = () => true;
  }
}

/** Installs the double as the global `IntersectionObserver` for the current test (vitest restores globals afterwards). */
export function installIntersectionObserver(visible: (el: Element) => boolean = () => true): typeof FakeIntersectionObserver {
  FakeIntersectionObserver.reset();
  FakeIntersectionObserver.visible = visible;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  return FakeIntersectionObserver;
}

/** Only the cards whose position among the strip slots (document order) is in `[from, to)` are "on screen". */
export function inRange(from: number, to: number): (el: Element) => boolean {
  return el => {
    const index = [...document.querySelectorAll('[data-strip-slot]')].indexOf(el);
    return index >= from && index < to;
  };
}
