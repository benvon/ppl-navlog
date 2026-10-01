import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { developmentBuildId } from './rc-version.mjs';

describe('development build identifier', () => {
  it('uses the independent workflow run number', () => {
    expect(developmentBuildId('42')).toBe('dev-42');
  });

  it('rejects invalid versions and run numbers', () => {
    expect(() => developmentBuildId('0')).toThrow();
    expect(() => developmentBuildId('1;echo x')).toThrow();
  });

  it('does not couple development IDs to package metadata or stable tags and only reuses a matching dev tag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'navlog-release-version-'));
    const script = resolve('scripts/rc-version.mjs');
    const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 5000 }).trim();
    const testEnvironment = { ...process.env };
    delete testEnvironment.GITHUB_OUTPUT;
    const run = (sha) => spawnSync(process.execPath, [script], {
      cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...testEnvironment, GITHUB_RUN_NUMBER: '42', GITHUB_SHA: sha },
    });

    try {
      await writeFile(join(directory, 'README.md'), 'fixture\n');
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'tag.gpgsign', 'false');
      git('config', 'core.hooksPath', '/dev/null');
      git('add', 'README.md');
      git('commit', '-qm', 'fixture');
      const sha = git('rev-parse', 'HEAD');
      git('tag', 'v0.1.1', sha);

      const fresh = run(sha);
      expect(fresh.status).toBe(0);
      expect(fresh.stdout.trim()).toBe('dev-42');

      git('tag', 'dev-42', sha);

      const reused = run(sha);
      expect(reused.status).toBe(0);
      expect(reused.stdout.trim()).toBe('dev-42');

      const mismatched = run('b'.repeat(40));
      expect(mismatched.status).not.toBe(0);
      expect(mismatched.stderr).toContain('dev-42 already points to a different commit');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
