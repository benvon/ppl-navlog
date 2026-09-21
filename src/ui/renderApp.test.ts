import { describe, expect, it } from 'vitest';
import { renderApp } from './renderApp';

describe('renderApp', () => {
  it('shows a non-sensitive build identity', () => {
    const root = document.createElement('div');

    renderApp(root, { version: 'v0.1.0', commitSha: 'abcdef1' });

    expect(root.textContent).toContain('PPL Navlog');
    expect(root.textContent).toContain('Build v0.1.0 (abcdef1)');
  });
});
