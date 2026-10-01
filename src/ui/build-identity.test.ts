import { describe, expect, it, vi } from 'vitest';
import { showBuildIdentity } from './build-identity';
const sha = 'a'.repeat(40);
const health = (data: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
describe('displayed release identity', () => {
  it('displays the stable runtime tag for the exact compiled commit', async () => {
    const element = document.createElement('p');
    await showBuildIdentity(element, 'dev-42', sha, health({ status: 'ok', version: 'v0.2.0', commitSha: sha }));
    expect(element.textContent).toBe(`Version v0.2.0 (${sha})`);
  });
  it.each([
    { status: 'ok', version: 'v0.2.0', commitSha: 'b'.repeat(40) },
    { status: 'ok', version: '<script>bad</script>', commitSha: sha },
    { status: 'ok', version: 'dev-42', commitSha: sha },
    { status: 'failed', version: 'v0.2.0', commitSha: sha },
    null,
  ])('retains build identity for unavailable or mismatched release data', async (data) => {
    const element = document.createElement('p');
    await showBuildIdentity(element, 'dev-42', sha, health(data));
    expect(element.textContent).toBe(`Build dev-42 (${sha})`);
  });
  it('does not query runtime identity for a local build', async () => {
    const element = document.createElement('p');
    const fetchHealth = vi.fn<typeof fetch>();
    await showBuildIdentity(element, 'local', 'local', fetchHealth);
    expect(fetchHealth).not.toHaveBeenCalled();
    expect(element.textContent).toBe('Build local (local)');
  });
  it('retains build identity when health is unavailable', async () => {
    const element = document.createElement('p');
    await showBuildIdentity(element, 'dev-42', sha, vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })));
    expect(element.textContent).toContain('Build dev-42');
  });
  it('retains build identity on transport failure', async () => {
    const element = document.createElement('p');
    await showBuildIdentity(element, 'dev-42', sha, vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
    expect(element.textContent).toContain('Build dev-42');
  });
});
