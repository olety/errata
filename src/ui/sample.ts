// The synthetic sample: the fixture sessions, bundled, and two starter rule files.
// Sample Apply writes to the browser's private storage, never to the player's files.

const raw = import.meta.glob('../../fixtures/**/*.jsonl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function sampleFiles(): { rel: string; blob: Blob }[] {
  return Object.entries(raw).map(([path, text]) => ({ rel: path.replace(/^.*fixtures\//, ''), blob: new Blob([text]) }));
}

export const SAMPLE_CLAUDE_MD = '# Personal rules\n\n- Answer in plain English.\n- Prefer small diffs.\n';
export const SAMPLE_AGENTS_MD = '# Codex rules\n\nUse the project test runner before reporting done.\n';

export async function sampleDirs(): Promise<{ claude: FileSystemDirectoryHandle; codex: FileSystemDirectoryHandle }> {
  const opfs = await navigator.storage.getDirectory();
  const base = await opfs.getDirectoryHandle('deck-sample', { create: true });
  const claude = await base.getDirectoryHandle('claude', { create: true });
  const codex = await base.getDirectoryHandle('codex', { create: true });
  for (const [dir, name, text] of [
    [claude, 'CLAUDE.md', SAMPLE_CLAUDE_MD],
    [codex, 'AGENTS.md', SAMPLE_AGENTS_MD],
  ] as const) {
    try {
      await dir.getFileHandle(name);
    } catch {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }
  return { claude, codex };
}

export async function resetSample(): Promise<void> {
  const opfs = await navigator.storage.getDirectory();
  try {
    await opfs.removeEntry('deck-sample', { recursive: true });
  } catch {
    /* nothing to reset */
  }
}
