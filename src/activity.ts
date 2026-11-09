/**
 * The agent activity log: one JSON line per hook event, one file per day
 * (`~/.aimonitor/actividad/YYYY-MM-DD.jsonl`), written by the aimonitor agent
 * hook. This plugin only reads it, to know what the working day went on.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ACTIVITY_DIR = '~/.aimonitor/actividad';

/** Providers that are not agent work (aimonitor writes detected calls as `llamada`). */
const NOT_WORK = new Set(['llamada']);

export interface ActivityEvent {
  /** ms epoch. */
  at: number;
  session: string;
  provider: string;
  project: string;
  cwd?: string;
  state: string;
  event: string;
}

/** `YYYY-MM-DD` in local time. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/** One day's events; broken lines (a write cut halfway) are skipped. */
export async function readActivity(day: string, dir = DEFAULT_ACTIVITY_DIR): Promise<ActivityEvent[]> {
  let text = '';
  try {
    text = await readFile(join(expandHome(dir), `${day}.jsonl`), 'utf8');
  } catch {
    return [];
  }
  const out: ActivityEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as ActivityEvent;
      if (typeof ev.at === 'number' && typeof ev.project === 'string' && !NOT_WORK.has(ev.provider)) out.push(ev);
    } catch {
      // Half a line.
    }
  }
  return out;
}

export interface Block {
  start: number;
  end: number;
}

export interface ProjectActivity {
  project: string;
  cwd?: string;
  blocks: Block[];
  /** ms. */
  total: number;
}

/**
 * Work blocks per project: events less than `gapMs` apart are one block,
 * lasting from its first event to the last plus `tailMs` (the time it takes to
 * read the answer and decide what next). A lone event counts `tailMs`. Most
 * time first.
 */
export function activityByProject(events: ActivityEvent[], gapMs = 15 * 60_000, tailMs = 5 * 60_000): ProjectActivity[] {
  const by = new Map<string, ActivityEvent[]>();
  for (const ev of events) by.set(ev.project, [...(by.get(ev.project) ?? []), ev]);
  const out: ProjectActivity[] = [];
  for (const [project, list] of by) {
    list.sort((a, b) => a.at - b.at);
    const blocks: Block[] = [];
    for (const ev of list) {
      const last = blocks.at(-1);
      if (last && ev.at - (last.end - tailMs) <= gapMs) last.end = Math.max(last.end, ev.at + tailMs);
      else blocks.push({ start: ev.at, end: ev.at + tailMs });
    }
    const merged: Block[] = [];
    for (const b of blocks) {
      const last = merged.at(-1);
      if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
      else merged.push({ ...b });
    }
    out.push({ project, cwd: list.at(-1)?.cwd, blocks: merged, total: merged.reduce((s, b) => s + b.end - b.start, 0) });
  }
  return out.sort((a, b) => b.total - a.total);
}
