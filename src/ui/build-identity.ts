/** Runtime release identity is trustworthy only for this exact static build. */
export async function showBuildIdentity(element: HTMLElement, buildId: string, commitSha: string, fetchHealth: typeof fetch = fetch): Promise<void> {
  element.textContent = `Build ${buildId} (${commitSha})`;
  if (!/^[a-f0-9]{40}$/.test(commitSha)) return;
  try {
    const response = await fetchHealth('/api/health', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok) return;
    const health: unknown = await response.json();
    if (typeof health !== 'object' || health === null) return;
    const { status, version, commitSha: runtimeSha } = health as Record<string, unknown>;
    if (status !== 'ok' || runtimeSha !== commitSha || typeof version !== 'string') return;
    if (/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
      element.textContent = `Version ${version} (${commitSha})`;
    }
  } catch {
    // Build identity remains visible when runtime release metadata is unavailable.
  }
}
