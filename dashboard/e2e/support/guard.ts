import type { BrowserContext } from '@playwright/test';

/**
 * The fixture rules, shared by the mock and the real-stack suites: a test fails on
 *   - console errors and warnings,
 *   - uncaught page errors and unhandled rejections,
 *   - Content-Security-Policy violations (a `securitypolicyviolation` event, or Chromium's own report),
 *   - requests that fail (not the ones the page aborted itself), and responses with status 400 or above,
 * unless the test said beforehand that it expects them (`allow.console(/…/)` and so on). An allowance that matched nothing
 * also fails the test, so a stale allowance cannot hide a regression later.
 */
export type Kind = 'console' | 'pageerror' | 'csp' | 'request';

export interface Observation {
  kind: Kind;
  /** One line that an allowance is matched against and a failure is reported with. */
  text: string;
}

interface Allowance {
  kind: Kind;
  pattern: RegExp;
  used: boolean;
}

export class Allow {
  readonly #items: Allowance[] = [];
  readonly #unexpected: Observation[] = [];
  readonly #seen: Observation[] = [];

  /** A console `error` or `warning` whose text matches. */
  console(pattern: RegExp): void { this.#add('console', pattern); }
  /** An uncaught exception or unhandled rejection whose message matches. */
  pageError(pattern: RegExp): void { this.#add('pageerror', pattern); }
  /** A Content-Security-Policy violation whose description matches (`blocked-uri directive`). */
  csp(pattern: RegExp): void { this.#add('csp', pattern); }
  /** A failed request (`METHOD url net::ERR_…`) or an error response (`METHOD url -> 404`). */
  request(pattern: RegExp): void { this.#add('request', pattern); }

  /** Every observation so far (also the allowed ones), for tests that assert on what the page logged. */
  get seen(): readonly Observation[] { return this.#seen; }

  record(kind: Kind, text: string): void {
    const observation = { kind, text };
    this.#seen.push(observation);
    const hit = this.#items.find(item => item.kind === kind && item.pattern.test(text));
    if (hit) hit.used = true;
    else this.#unexpected.push(observation);
  }

  /** Problems to report at the end of the test: unexpected observations, then allowances nothing matched. */
  problems(): string[] {
    // An allowance added after the event (a late `allow.console()`) still counts when it matches an earlier observation.
    const late = this.#unexpected.filter(o => {
      const hit = this.#items.find(item => item.kind === o.kind && item.pattern.test(o.text));
      if (hit) hit.used = true;
      return !hit;
    });
    return [
      ...late.map(o => `unexpected ${o.kind}: ${o.text}`),
      ...this.#items.filter(item => !item.used).map(item => `allowed ${item.kind} never happened: ${item.pattern}`),
    ];
  }

  #add(kind: Kind, pattern: RegExp): void { this.#items.push({ kind, pattern, used: false }); }
}

interface CspReport {
  blockedURI: string;
  directive: string;
  sourceFile: string;
  line: number;
  sample: string;
}

/** Records into `allow` everything the rules above forbid, for every page of the context (also popups and later pages). */
export async function watch(context: BrowserContext, allow: Allow): Promise<void> {
  await context.exposeBinding('__e2eCsp', (_source, report: CspReport) => {
    allow.record('csp', `${report.blockedURI} ${report.directive} (${report.sourceFile}:${report.line}) ${report.sample}`.trim());
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      const report = { blockedURI: event.blockedURI, directive: event.violatedDirective, sourceFile: event.sourceFile, line: event.lineNumber, sample: event.sample };
      void (window as unknown as { __e2eCsp(r: typeof report): Promise<void> }).__e2eCsp(report);
    });
  });
  context.on('console', message => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') return;
    const location = message.location();
    const where = location.url ? ` (${location.url}:${location.lineNumber})` : '';
    // Chromium reports a violation as a console error as well; classify it so that `allow.csp()` covers both.
    allow.record(/Content Security Policy|Content-Security-Policy/.test(message.text()) ? 'csp' : 'console', `${type}: ${message.text()}${where}`);
  });
  context.on('weberror', error => allow.record('pageerror', String(error.error())));
  context.on('requestfailed', request => {
    const error = request.failure()?.errorText ?? 'failed';
    // ERR_ABORTED is a request the page cancelled itself: an AbortController (the dashboard aborts the requests of a view that is gone,
    // by design) or a navigation. Every other failure is a real one.
    if (error === 'net::ERR_ABORTED') return;
    allow.record('request', `${request.method()} ${request.url()} ${error}`);
  });
  context.on('response', response => {
    if (response.status() >= 400) allow.record('request', `${response.request().method()} ${response.url()} -> ${response.status()}`);
  });
}

