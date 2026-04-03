import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { resolve } from 'path';

/**
 * Produces a stable workspace ID from a git remote URL.
 * Strips protocol, auth, and trailing .git for normalization.
 */
export function workspaceIdFromGitRemote(remoteUrl: string): string {
  const normalized = remoteUrl
    .replace(/^[a-z+]+:\/\//, '')   // strip protocol
    .replace(/^[^@]*@/, '')          // strip user@
    .replace(/\.git\/?$/, '')        // strip trailing .git
    .replace(/:\d+\//, '/')          // strip port in ssh-style URLs
    .replace(':', '/')               // normalize ssh colon to slash
    .toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Produces a stable workspace ID from an absolute directory path.
 */
export function workspaceIdFromPath(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Auto-detect workspace ID by trying git remote first, then falling back
 * to a hash of the current working directory.
 *
 * Returns null if detection fails entirely (e.g. no cwd access).
 */
export function detectWorkspace(cwd?: string): string | null {
  const dir = cwd ?? process.cwd();

  // Try git remote origin
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (remoteUrl) {
      return workspaceIdFromGitRemote(remoteUrl);
    }
  } catch {
    // Not a git repo or no remote — fall through
  }

  // Fallback to directory path hash
  try {
    return workspaceIdFromPath(dir);
  } catch {
    return null;
  }
}
