import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME_FLAGS, chromePath } from './chrome';

test('the pixel tests use CHROME_PATH or Chrome for Testing, never the installed Chrome, and skip when neither exists', () => {
  const empty = mkdtempSync(join(tmpdir(), 'cft-none-'));
  expect(chromePath({ ERRATA_CFT_ROOT: empty })).toBeNull();
  expect(chromePath({ CHROME_PATH: join(empty, 'missing') })).toBeNull();
  const root = mkdtempSync(join(tmpdir(), 'cft-'));
  const bin = join(root, 'linux-1', 'chrome-linux64');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'chrome'), '');
  expect(chromePath({ ERRATA_CFT_ROOT: root })).toBe(join(bin, 'chrome'));
  expect(CHROME_FLAGS).toContain('--use-mock-keychain');
  expect(CHROME_FLAGS).toContain('--password-store=basic');
});
