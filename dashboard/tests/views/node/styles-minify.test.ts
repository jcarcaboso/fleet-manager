/**
 * Shared bug found while comparing screenshots: lightningcss (Vite's CSS minifier) keeps only the LAST of `backdrop-filter` and
 * `-webkit-backdrop-filter` when the prefixed one is written second, so the production build had no `backdrop-filter` and neither the
 * top bar nor the modal backdrop was blurred in Chrome and Firefox. The prefixed property must come first.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transform } from 'lightningcss';
import { describe, expect, it } from 'vitest';

const css = (file: string): string => readFileSync(resolve(process.cwd(), 'src/styles', file), 'utf8');
const minified = (file: string): string => transform({ filename: file, code: Buffer.from(css(file)), minify: true, targets: { chrome: 94 << 16, safari: 15 << 16, firefox: 93 << 16 } }).code.toString();

describe('minified stylesheet', () => {
  it.each([['layout.css', '.topbar'], ['overlays.css', '.modal-back']])('%s keeps the unprefixed backdrop-filter of %s', (file, selector) => {
    const rule = new RegExp(`${selector.replace('.', '\\.')}\\{[^}]*\\}`).exec(minified(file))?.[0] ?? '';
    expect(rule).toMatch(/(^|[;{])backdrop-filter:/);
    expect(rule).toMatch(/-webkit-backdrop-filter:/);
  });
  it('no stylesheet writes -webkit-backdrop-filter after backdrop-filter', () => {
    for (const f of ['layout.css', 'overlays.css', 'components.css', 'base.css', 'pages.css', 'live.css', 'tokens.css']) {
      expect(css(f), f).not.toMatch(/(^|[;{\s])backdrop-filter:[^;}]*;\s*-webkit-backdrop-filter:/);
    }
  });
});
