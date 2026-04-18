import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, 'test-transcriptions');

// Minimal storage implementation for testing (mirrors server.js local storage)
async function storageSave(filename, content) {
  const safeName = filename.split('/').pop();
  const path = join(TEST_DIR, safeName);
  await writeFile(path, content);
  return path;
}

async function storageRead(filename) {
  const safeName = filename.split('/').pop();
  return await readFile(join(TEST_DIR, safeName), 'utf-8');
}

async function storageList(suffix) {
  const files = await readdir(TEST_DIR);
  return files.filter((f) => f.endsWith(suffix));
}

async function storageDelete(filename) {
  const { unlink } = await import('node:fs/promises');
  const safeName = filename.split('/').pop();
  try {
    await unlink(join(TEST_DIR, safeName));
    return true;
  } catch {
    return false;
  }
}

describe('Storage Abstraction', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('storageSave', () => {
    it('saves text content to file', async () => {
      const path = await storageSave('test-meeting.txt', 'Hello World');
      assert.ok(path.includes('test-meeting.txt'));
      const content = await readFile(path, 'utf-8');
      assert.equal(content, 'Hello World');
    });

    it('saves buffer content to file', async () => {
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const path = await storageSave('test-audio.webm', buf);
      const content = await readFile(path);
      assert.ok(content.equals(buf));
    });

    it('strips directory components from filename', async () => {
      const path = await storageSave('transcriptions/../../../etc/passwd.txt', 'safe');
      assert.ok(!path.includes('..'));
      assert.ok(!path.includes('etc'));
      assert.ok(path.includes('passwd.txt'));
    });
  });

  describe('storageRead', () => {
    it('reads saved text content', async () => {
      await storageSave('read-test.txt', 'Test content');
      const content = await storageRead('read-test.txt');
      assert.equal(content, 'Test content');
    });

    it('throws on missing file', async () => {
      await assert.rejects(
        () => storageRead('nonexistent.txt'),
        /ENOENT|no such file/
      );
    });
  });

  describe('storageList', () => {
    it('lists files matching suffix', async () => {
      // Clean up any leftover files first
      const existing = await storageList('.md');
      for (const f of existing) await storageDelete(f);
      const existingTxt = await storageList('.txt');
      for (const f of existingTxt) await storageDelete(f);

      await storageSave('meeting-1-summary.md', '# Meeting 1');
      await storageSave('meeting-2-summary.md', '# Meeting 2');
      await storageSave('meeting-1.txt', 'Transcript');

      const summaries = await storageList('-summary.md');
      assert.equal(summaries.length, 2);
      assert.ok(summaries.includes('meeting-1-summary.md'));
      assert.ok(summaries.includes('meeting-2-summary.md'));

      const txts = await storageList('.txt');
      assert.equal(txts.length, 1);
      assert.ok(txts.includes('meeting-1.txt'));
    });
  });

  describe('storageDelete', () => {
    it('deletes existing file', async () => {
      await storageSave('delete-me.md', 'To be deleted');
      const result = await storageDelete('delete-me.md');
      assert.equal(result, true);
      await assert.rejects(
        () => storageRead('delete-me.md'),
        /ENOENT|no such file/
      );
    });

    it('returns false for non-existent file', async () => {
      const result = await storageDelete('does-not-exist.md');
      assert.equal(result, false);
    });
  });

  describe('full workflow', () => {
    it('save, list, read, delete cycle', async () => {
      const baseName = 'meeting-test-2024-01-01';

      // Save
      await storageSave(`${baseName}-summary.md`, '# Reunion Test\n\n## Resumen\nTest content');
      await storageSave(`${baseName}.txt`, 'Full transcript here');
      await storageSave(`${baseName}-insights.json`, JSON.stringify({ summary: 'Test' }));

      // List
      const summaries = await storageList('-summary.md');
      assert.ok(summaries.some((f) => f.startsWith('meeting-test-2024-01-01')));

      // Read
      const summary = await storageRead(`${baseName}-summary.md`);
      assert.ok(summary.includes('# Reunion Test'));

      // Delete all
      const files = [
        `${baseName}-summary.md`,
        `${baseName}.txt`,
        `${baseName}-insights.json`,
      ];
      for (const f of files) {
        await storageDelete(f);
      }

      // Verify deleted
      const remaining = await storageList('-summary.md');
      assert.ok(!remaining.some((f) => f.startsWith('meeting-test-2024-01-01')));
    });
  });
});
