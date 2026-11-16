#!/usr/bin/env node
// Fetch only the exact upstream Sparkle release. Extraction is safe because the
// complete archive is authenticated against the checked-in digest before tar runs.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SPARKLE_VERSION = '2.10.1';
export const SPARKLE_URL = 'https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz';
export const SPARKLE_SHA256 = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27';
export function verifySparkleArchive(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== SPARKLE_SHA256) throw new Error('Sparkle archive SHA-256 mismatch.');
}
export async function prepareSparkle(destination) {
  if (process.platform !== 'darwin') throw new Error('Sparkle preparation requires macOS.');
  const target = resolve(destination);
  const temporary = await mkdtemp(join(tmpdir(), 'kestrel-sparkle-'));
  try {
    const response = await fetch(SPARKLE_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Sparkle download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifySparkleArchive(bytes);
    const archive = join(temporary, 'sparkle.tar.xz');
    await writeFile(archive, bytes, { mode: 0o600 });
    const extracted = join(temporary, 'contents');
    await mkdir(extracted);
    execFileSync('/usr/bin/tar', ['-xJf', archive, '-C', extracted], { stdio: 'inherit' });
    await readFile(join(extracted, 'Sparkle.framework', 'Headers', 'SPUStandardUpdaterController.h'));
    // Do not overwrite a previously staged release dependency.
    await mkdir(target);
    execFileSync('/usr/bin/ditto', [join(extracted, 'Sparkle.framework'), join(target, 'Sparkle.framework')], { stdio: 'inherit' });
    return target;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Provide a new destination directory for the verified Sparkle framework.');
  console.log(`Prepared verified Sparkle ${SPARKLE_VERSION} in ${await prepareSparkle(process.argv[2])}`);
}
