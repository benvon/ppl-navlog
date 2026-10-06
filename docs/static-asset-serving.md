# Static asset serving (issue #47)

## Behavioral contract

Static files and SPA fallbacks are served by Cloudflare Static Assets without invoking application Worker code. Base, development, and production configurations set `assets.run_worker_first` to `["/api/*"]`; API navigation and unknown API paths still reach the Worker. API security policy, rate limiting, and request IDs remain in the Worker. Static responses no longer generate `X-Request-Id`. Static unsupported-method 405 responses retain the security policy but have no platform cache header; smoke requires security and the correct status on those errors, not document revalidation.

`public/_headers` supplies the existing CSP, permissions, referrer, nosniff, and framing protections to all static responses. The build appends exact immutable cache rules for the fingerprinted files actually present in `dist/assets`. Build verification rejects missing or changed security/cache policies, duplicate or additional header rules, unsafe or unhashed assets, unresolved HTML references, and more than 100 rules. Broad `/assets/*` immutable rules are deliberately avoided: a missing asset can return SPA HTML, which must not become immutable.

| Resource | Cache policy |
| --- | --- |
| HTML, SPA fallback, robots | Cloudflare default `public, max-age=0, must-revalidate` |
| `/version.json` | `no-store` |
| Exact built fingerprinted asset | `public, max-age=31536000, immutable` |
| API | Existing `no-store` |

The same validated static artifact is promoted. Production smoke continues comparing the manifest's development build identifier against `BUILD_VERSION`, and the API's stable release version against `RELEASE_VERSION`, with both commit SHAs matching the candidate SHA.

## Verification

Run `mise exec -- npm run build` followed by `mise exec -- npm run verify:static-routing`, or the complete `mise exec -- npm run ci`. CI runs routing verification after building the artifact.

The local routing check wraps the real Worker with an invocation counter and runs Wrangler's asset router using each environment's asset configuration. It covers HTML, built JS/CSS, manifest, robots, deep SPA fallback, missing hashed-looking files, the non-served `_headers` control file, HEAD, conditional 304, unsupported POST/OPTIONS 405, and API navigation/unknown routes. The test fixture runs locally and never calls aviation providers or deployed services.

On 2026-10-06, the local replay of the current empty-plan cold-load request pattern (`/`, built JS, built CSS, `/api/health`) measured **4 → 1 Worker invocations**, saving three invocations (75 percent). All three configurations passed. This is a controlled request replay; restored plans or user actions may add API traffic, which remains metered.

Development and production deployment smoke validate actual response policy on deployed static paths and retain the existing release-identity and airport checks. Both production domains must pass. Local routing checks do not establish deployed behavior; live verification is pending deployment through the approved release process.

Cloudflare platform behavior is defined by [Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/) and [SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/). `_headers` does not replace the API's Worker-applied policy.
