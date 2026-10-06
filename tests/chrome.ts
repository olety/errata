// The headless browser for the pixel tests. Chrome for Testing only: on the owner's Mac a headless launch of the
// installed Google Chrome shares its bundle id and raises his open Chrome, so it is never a fallback. Order:
// CHROME_PATH, then the newest Chrome for Testing under ~/.cache/plate-film-chrome (or ERRATA_CFT_ROOT). With none,
// the pixel tests skip (the Pages workflow runs without a browser).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CFT_BINARIES = [
  ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-linux64', 'chrome'],
];

export function chromePath(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  const root = env.ERRATA_CFT_ROOT ?? join(homedir(), '.cache', 'plate-film-chrome', 'chrome');
  let builds: string[] = [];
  try {
    builds = readdirSync(root).sort().reverse();
  } catch {
    return null;
  }
  for (const b of builds) for (const parts of CFT_BINARIES) {
    const p = join(root, b, ...parts);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Flags for every launch: headless, no keychain prompt for a fresh profile, no first-run UI. */
export const CHROME_FLAGS = ['--headless=new', '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1'];
