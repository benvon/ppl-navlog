import { describe, expect, it } from 'vitest';
import { renderApp } from './renderApp';

describe('renderApp', () => {
  it('shows a non-sensitive build identity', () => {
    const root = document.createElement('div');

    renderApp(root, { version: 'v0.1.0', commitSha: 'abcdef1' });

    expect(root.textContent).toContain('PPL Navlog');
    expect(root.textContent).toContain('Build v0.1.0 (abcdef1)');
    expect(root.querySelector('.teaching-disclaimer')?.textContent).toBe('For teaching purposes only. Not for actual flight planning or a complete preflight briefing.');
    const main = root.querySelector('main')!;
    expect(main.querySelector('footer .build-identity')?.textContent).toBe('Build v0.1.0 (abcdef1)');
    expect([...main.children].indexOf(main.querySelector('.teaching-disclaimer')!)).toBeLessThan([...main.children].indexOf(main.querySelector('footer')!));
  });
});
