import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The security rules of docs/plans/separate-dashboard.md, enforced on the source: nothing in src/ may build markup from
 * strings, evaluate code, or use browser storage. Add a view that needs one of these and this test fails.
 */
const ROOT = resolve(process.cwd());
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(vue|ts|js|css|html)$/.test(name)) out.push(path);
  }
  return out;
}
const sources = files(join(ROOT, 'src'));
const strip = (text: string): string => text; // comments are scanned too: a rule that is only "documented away" is still a smell

const FORBIDDEN: Array<[string, RegExp]> = [
  ['v-html', /v-html/],
  ['innerHTML', /innerHTML/],
  ['outerHTML', /outerHTML/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['document.write', /document\.write/],
  ['eval(', /(^|[^A-Za-z0-9_$.])eval\s*\(/],
  ['new Function', /new\s+Function\b/],
  ['Function(', /(^|[^A-Za-z0-9_$.])Function\s*\(\s*['"`]/],
  ['setTimeout with a string', /set(Timeout|Interval)\s*\(\s*['"`]/],
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['indexedDB', /indexedDB/],
  ['javascript: URL', /javascript:/i],
  ['srcdoc', /srcdoc/],
  ['inline event handler string', /\son[a-z]+\s*=\s*["']/i],
  ['style attribute', /\sstyle\s*=\s*["']/],
  ['setAttribute style', /setAttribute\(\s*['"]style['"]/],
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['cookie write', /document\.cookie\s*=/],
];

describe('source scan', () => {
  it('finds the sources it is supposed to scan', () => {
    expect(sources.length).toBeGreaterThan(80);
    expect(sources.some(f => f.endsWith('client.ts'))).toBe(true);
    expect(sources.some(f => f.endsWith('Modal.vue'))).toBe(true);
  });

  for (const [name, pattern] of FORBIDDEN) {
    it(`src/ never uses ${name}`, () => {
      const hits = sources
        .filter(f => !f.endsWith('.css'))
        .flatMap(f => strip(readFileSync(f, 'utf8')).split('\n').map((line, i) => ({ f: relative(ROOT, f), line: i + 1, text: line })).filter(l => pattern.test(l.text)));
      expect(hits, hits.map(h => `${h.f}:${h.line}: ${h.text.trim()}`).join('\n')).toEqual([]);
    });
  }

  it('the stylesheet loads no external resources (fonts, images, imports)', () => {
    for (const f of sources.filter(x => x.endsWith('.css'))) {
      const css = readFileSync(f, 'utf8');
      expect(css, relative(ROOT, f)).not.toMatch(/@import|url\(|@font-face/);
    }
  });

  it('index.html has no inline script or style, no style attribute and no third-party URL', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(script[1]).toMatch(/\ssrc="/);
      expect(script[2]!.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle\s*=/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('the runtime dependencies are vue and vue-router only, pinned exactly', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['vue', 'vue-router']);
    for (const [name, version] of [...Object.entries(pkg.dependencies), ...Object.entries(pkg.devDependencies)]) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('the Operator token has exactly one use: the body of POST login', () => {
    const uses = sources.filter(f => /\.(ts|vue)$/.test(f)).filter(f => readFileSync(f, 'utf8').split('\n').some(line => !/^\s*(\*|\/\/|\/\*)/.test(line) && /post\(\s*['"]login['"]/.test(line)));
    expect(uses.map(f => relative(ROOT, f))).toEqual(['src/api/session.ts']);
  });
});
