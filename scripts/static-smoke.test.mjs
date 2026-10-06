import { describe, expect, it } from 'vitest';
import { assertStaticResponse, discoverStaticAssets } from './static-smoke.mjs';

const staticHeaders = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; form-action 'none'; object-src 'none'",
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function fixture({ headers = {}, status = 200 } = {}) {
  const values = new Map(Object.entries({ ...staticHeaders, ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
  return { status, headers: { get: (name) => values.get(name.toLowerCase()) ?? null } };
}

describe('static deployment smoke policy', () => {
  it.each(Object.keys(staticHeaders))('rejects a missing %s header', (header) => {
    expect(() => assertStaticResponse('/robots.txt', fixture({ headers: { [header]: null } }), { revalidate: true }))
      .toThrow(`static security header ${header} missing or invalid`);
  });

  it('rejects an unexpected request id on static responses', () => {
    expect(() => assertStaticResponse('/', fixture({ headers: { 'X-Request-Id': 'worker-id' } }), { revalidate: true }))
      .toThrow('static response unexpectedly includes X-Request-Id');
  });

  it.each(['public, max-age=31536000, immutable', 'public, max-age=31536000, must-revalidate', 'max-age=60, must-revalidate', ''])('requires revalidation and forbids immutable on entry documents (Cache-Control: %s)', (cacheControl) => {
    expect(() => assertStaticResponse('/', fixture({ headers: { 'Cache-Control': cacheControl } }), { revalidate: true }))
      .toThrow('static response must revalidate');
  });

  it('allows max-age=0 only when must-revalidate is also set', () => {
    expect(() => assertStaticResponse('/', fixture({ headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' } }), { revalidate: true })).not.toThrow();
  });

  it('requires the exact immutable policy and a JavaScript content type for built assets', () => {
    expect(() => assertStaticResponse('/assets/app-a1b2.js', fixture({ headers: { 'Cache-Control': 'public, max-age=60, immutable', 'Content-Type': 'text/javascript' } }), { immutable: true, contentType: 'javascript' }))
      .toThrow('static asset cache policy invalid');
    expect(() => assertStaticResponse('/assets/app-a1b2.js', fixture({ headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': 'text/html' } }), { immutable: true, contentType: 'javascript' }))
      .toThrow('static asset content type invalid');
  });

  it('requires no-store on the version manifest', () => {
    expect(() => assertStaticResponse('/version.json', fixture({ headers: { 'Cache-Control': 'no-cache' } }), { noStore: true }))
      .toThrow('version manifest cache policy invalid');
    expect(() => assertStaticResponse('/version.json', fixture({ headers: { 'Cache-Control': 'no-store, max-age=60' } }), { noStore: true }))
      .toThrow('version manifest cache policy invalid');
  });

  it('discovers root-relative built JavaScript and CSS assets', () => {
    expect(discoverStaticAssets('<link rel="stylesheet" href="/assets/app-Ab12.css"><script type="module" src="/assets/app-Xy34.js"></script>'))
      .toEqual({ javascript: ['/assets/app-Xy34.js'], css: ['/assets/app-Ab12.css'] });
  });

  it('discovers nested built assets using the same path characters as the build', () => {
    expect(discoverStaticAssets('<link rel="stylesheet" href="/assets/styles/theme.v1/app-a1b2c3d4.css"><script src="/assets/chunks/_vendor/app-a1b2c3d4.js"></script>'))
      .toEqual({ javascript: ['/assets/chunks/_vendor/app-a1b2c3d4.js'], css: ['/assets/styles/theme.v1/app-a1b2c3d4.css'] });
  });

  it.each([
    '<script src="https://evil.example/app.js"></script>',
    '<script src="//evil.example/app.js"></script>',
    '<script src="data:text/javascript,alert(1)"></script>',
    '<link rel="stylesheet" href="/assets/../evil.css">',
    '<script src="/assets/chunks/../app-a1b2c3d4.js"></script>',
    '<script src="/assets/chunks/./app-a1b2c3d4.js"></script>',
    '<script src="/assets/chunks//app-a1b2c3d4.js"></script>',
    '<script src="/assets/%2e%2e/app-a1b2c3d4.js"></script>',
    '<script src="/assets/chunks%2fapp-a1b2c3d4.js"></script>',
    '<script src="/assets/chunks\\app-a1b2c3d4.js"></script>',
  ])('refuses unsafe HTML asset references without interpreting them as URLs: %s', (html) => {
    expect(() => discoverStaticAssets(html)).toThrow('unsafe static asset reference');
  });
});
