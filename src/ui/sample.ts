// The synthetic sample: eleven tiny sessions in both real schemas plus a pair of rule files, served from
// public/sample and run through the same pipeline as real logs. Sample Apply writes to the browser's private storage
// (three folders standing in for ~/.claude, ~/.codex and ~/.agents), never to the player's files.

export const SAMPLE_LABEL = 'synthetic sample';

interface Manifest {
  label: string;
  sessions: { session: string; agent: 'claude' | 'codex'; file: string }[];
}

const base = () => new URL('./sample/', document.baseURI).toString();

async function fetchText(rel: string): Promise<string> {
  const r = await fetch(base() + rel);
  if (!r.ok) throw new Error(`The synthetic sample is missing ${rel} (${r.status}).`);
  return r.text();
}

export async function sampleFiles(): Promise<{ rel: string; blob: Blob; agent: 'claude' | 'codex' }[]> {
  const m = JSON.parse(await fetchText('manifest.json')) as Manifest;
  if (m.label !== SAMPLE_LABEL) throw new Error('The sample manifest is not the synthetic sample.');
  return Promise.all(m.sessions.map(async (s) => ({ rel: s.file.replace(/^home\/\.(?:claude|codex)\//, ''), blob: new Blob([await fetchText(s.file)]), agent: s.agent })));
}

export async function sampleDirs(): Promise<{ claude: FileSystemDirectoryHandle; codex: FileSystemDirectoryHandle; agents: FileSystemDirectoryHandle }> {
  const opfs = await navigator.storage.getDirectory();
  const root = await opfs.getDirectoryHandle('deck-sample', { create: true });
  const claude = await root.getDirectoryHandle('claude', { create: true });
  const codex = await root.getDirectoryHandle('codex', { create: true });
  const agents = await root.getDirectoryHandle('agents', { create: true });
  for (const [dir, name, rel] of [
    [claude, 'CLAUDE.md', 'home/.claude/CLAUDE.md'],
    [codex, 'AGENTS.md', 'home/.codex/AGENTS.md'],
  ] as const) {
    try {
      await dir.getFileHandle(name);
    } catch {
      const text = await fetchText(rel);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }
  return { claude, codex, agents };
}

export async function resetSample(): Promise<void> {
  const opfs = await navigator.storage.getDirectory();
  try {
    await opfs.removeEntry('deck-sample', { recursive: true });
  } catch {
    /* nothing to reset */
  }
}
