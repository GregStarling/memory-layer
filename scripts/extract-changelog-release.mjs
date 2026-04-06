import { readFile } from 'node:fs/promises';

const requestedVersion =
  process.argv[2] ??
  process.env.RELEASE_VERSION ??
  process.env.GITHUB_REF_NAME?.replace(/^v/, '') ??
  null;

function normalizeVersion(raw) {
  return raw?.trim().replace(/^v/, '') || null;
}

function collectReleaseSection(lines, version) {
  const startIndex = lines.findIndex((line) =>
    version ? line.startsWith(`## ${version}`) : line.startsWith('## '),
  );

  if (startIndex < 0) {
    throw new Error(
      version
        ? `Could not find release notes for version ${version} in CHANGELOG.md`
        : 'Could not find any release section in CHANGELOG.md',
    );
  }

  const endIndex = lines.findIndex((line, index) => index > startIndex && line.startsWith('## '));
  const bodyLines = lines.slice(startIndex + 1, endIndex < 0 ? lines.length : endIndex);
  return bodyLines.join('\n').trim();
}

const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.replace(/\r\n/g, '\n').split('\n');
const version = normalizeVersion(requestedVersion);
const notes = collectReleaseSection(lines, version);

if (!notes) {
  throw new Error(
    version
      ? `Release section for ${version} is present but empty in CHANGELOG.md`
      : 'Latest release section in CHANGELOG.md is empty',
  );
}

process.stdout.write(`${notes}\n`);
