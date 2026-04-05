import { describe, it, expect } from 'vitest';
import { workspaceIdFromGitRemote, workspaceIdFromPath, detectWorkspace } from '../core/workspace-detect.js';
import { resolve } from 'path';

describe('workspace detection', () => {
  describe('workspaceIdFromGitRemote', () => {
    it('produces a stable 16-char hex hash', () => {
      const id = workspaceIdFromGitRemote('git@github.com:acme/memory-layer.git');
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('normalizes SSH and HTTPS URLs to same ID', () => {
      const ssh = workspaceIdFromGitRemote('git@github.com:acme/memory-layer.git');
      const https = workspaceIdFromGitRemote('https://github.com/acme/memory-layer.git');
      expect(ssh).toBe(https);
    });

    it('strips trailing .git', () => {
      const withGit = workspaceIdFromGitRemote('https://github.com/acme/repo.git');
      const withoutGit = workspaceIdFromGitRemote('https://github.com/acme/repo');
      expect(withGit).toBe(withoutGit);
    });

    it('is case-insensitive', () => {
      const lower = workspaceIdFromGitRemote('https://github.com/Acme/Repo.git');
      const upper = workspaceIdFromGitRemote('https://GITHUB.COM/acme/repo');
      expect(lower).toBe(upper);
    });

    it('strips auth from URL', () => {
      const withAuth = workspaceIdFromGitRemote('https://token:x-oauth@github.com/acme/repo.git');
      const without = workspaceIdFromGitRemote('https://github.com/acme/repo');
      expect(withAuth).toBe(without);
    });

    it('produces different IDs for different repos', () => {
      const a = workspaceIdFromGitRemote('git@github.com:acme/repo-a.git');
      const b = workspaceIdFromGitRemote('git@github.com:acme/repo-b.git');
      expect(a).not.toBe(b);
    });
  });

  describe('workspaceIdFromPath', () => {
    it('produces a stable 16-char hex hash', () => {
      const id = workspaceIdFromPath('/Users/dev/projects/memory-layer');
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces same ID for same absolute path', () => {
      const a = workspaceIdFromPath('/Users/dev/projects/memory-layer');
      const b = workspaceIdFromPath('/Users/dev/projects/memory-layer');
      expect(a).toBe(b);
    });

    it('resolves relative-style paths consistently', () => {
      const abs = workspaceIdFromPath('/Users/dev/projects/memory-layer');
      const withDot = workspaceIdFromPath('/Users/dev/projects/./memory-layer');
      expect(abs).toBe(withDot);
    });

    it('produces different IDs for different paths', () => {
      const a = workspaceIdFromPath('/Users/dev/project-a');
      const b = workspaceIdFromPath('/Users/dev/project-b');
      expect(a).not.toBe(b);
    });
  });

  describe('detectWorkspace', () => {
    it('returns a string when run in a git repo', () => {
      // This test repo itself has a git remote
      const id = detectWorkspace(resolve(__dirname, '../..'));
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns a string for a non-git directory (falls back to path)', () => {
      const id = detectWorkspace('/tmp');
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('falls back to path hash for nonexistent directory', () => {
      const id = detectWorkspace('/nonexistent/path/that/does/not/exist');
      // Falls back to path hash — path hashing itself doesn't require the dir to exist
      // since it just hashes the resolved string
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});
