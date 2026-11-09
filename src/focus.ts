/**
 * Focus: what you have logged today, what you should have by now and what is
 * still to log. The pending part comes from three places: today's meetings
 * that have already ended (the `calendar/events` source), agent activity per
 * project (the activity log, see activity.ts) and what is already logged in
 * GitLab. A meeting counts as logged if one of today's timelogs carries its
 * marker (`meetingMarker`, `[cal YYYY-MM-DD HH:MM]`), as aimonitor's logging
 * tool writes it: never logged twice, no guessing from the text.
 */
import type { Localized } from '@kiosko/sdk';
import { dataOf, type GraphQL } from './gitlab.ts';

export interface LoggedEntry {
  hours: number;
  /** ms epoch. */
  spentAt: number;
  summary: string;
  /** GitLab project path (`acme/web-app`). */
  project: string;
  /** `acme/web-app!412`, `acme/api#6`… or null. */
  ref: string | null;
}

/** My timelogs between two days (YYYY-MM-DD, the second excluded). */
export function myTimelogsQuery(me: string, startDate: string, endDate: string): string {
  return `{ timelogs(username: ${JSON.stringify(me)}, startDate: ${JSON.stringify(startDate)}, endDate: ${JSON.stringify(endDate)}, first: 100) { nodes { timeSpent spentAt summary project { fullPath } issue { reference(full: true) } mergeRequest { reference(full: true) } } } }`;
}

type Node = { timeSpent?: number; spentAt?: string; summary?: string | null; project?: { fullPath?: string }; issue?: { reference?: string } | null; mergeRequest?: { reference?: string } | null };

export function parseMyTimelogs(text: string): LoggedEntry[] {
  const out: LoggedEntry[] = [];
  for (const n of dataOf<{ timelogs?: { nodes?: Node[] } }>(text)?.timelogs?.nodes ?? []) {
    const at = Date.parse(n.spentAt ?? '');
    if (!Number.isFinite(at) || typeof n.timeSpent !== 'number') continue;
    out.push({ hours: n.timeSpent / 3600, spentAt: at, summary: n.summary ?? '', project: n.project?.fullPath ?? '', ref: n.issue?.reference ?? n.mergeRequest?.reference ?? null });
  }
  return out;
}

export async function fetchMyTimelogs(gql: GraphQL, me: string, day: string, nextDay: string): Promise<LoggedEntry[]> {
  return parseMyTimelogs(await gql(myTimelogsQuery(me, day, nextDay)));
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The marker of a meeting in its timelog summary: `[cal 2026-10-13 10:00]`. */
export function meetingMarker(m: { startsAt: number }): string {
  const d = new Date(m.startsAt);
  return `[cal ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm(m.startsAt)}]`;
}

/** A calendar meeting, as `calendar/events` delivers it. */
export interface MeetingLike {
  title: string;
  startsAt: number;
  endsAt: number;
  private?: boolean;
  tentative?: boolean;
}

export interface PendingProject {
  project: string;
  /** Minutes of activity today, logged today in that project and still to log. */
  activity: number;
  logged: number;
  pending: number;
}

export interface FocusView {
  /** Hours logged today, and the ones due by now. */
  logged: number;
  expected: number;
  meetings: MeetingLike[];
  projects: PendingProject[];
}

export interface FocusInput {
  now: number;
  /** Today's meetings (finished ones included). */
  meetings: MeetingLike[];
  logged: LoggedEntry[];
  activity: { project: string; total: number }[];
  expected: number;
  /** Below this, a project's activity is not proposed. */
  minPendingMin?: number;
}

/** The last piece of a GitLab path or a directory: `acme/web-app` → `web-app`. */
const leaf = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

export function focusView(i: FocusInput): FocusView {
  const minPending = i.minPendingMin ?? 15;
  const summaries = i.logged.map((l) => l.summary).join('\n');
  const meetings = i.meetings.filter((m) => m.endsAt <= i.now && !summaries.includes(meetingMarker(m))).sort((a, b) => a.startsAt - b.startsAt);
  const loggedBy = new Map<string, number>();
  for (const l of i.logged) loggedBy.set(leaf(l.project), (loggedBy.get(leaf(l.project)) ?? 0) + l.hours * 60);
  const projects: PendingProject[] = [];
  for (const a of i.activity) {
    const activity = Math.round(a.total / 60_000);
    const logged = Math.round(loggedBy.get(leaf(a.project)) ?? 0);
    const pending = activity - logged;
    if (pending >= minPending) projects.push({ project: a.project, activity, logged, pending });
  }
  projects.sort((a, b) => b.pending - a.pending);
  return { logged: i.logged.reduce((s, l) => s + l.hours, 0), expected: i.expected, meetings, projects };
}

/** "1 h 30 min", "45 min". */
export function minutesText(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

export const TEXT = {
  loggedToday: { en: 'logged today', es: 'imputado hoy' },
  due: { en: 'due', es: 'toca' },
  left: { en: 'left', es: 'faltan' },
  notLogged: { en: 'NOT LOGGED', es: 'SIN IMPUTAR' },
  nothing: { en: 'Nothing left to log', es: 'Nada pendiente de imputar' },
  unlogged: { en: 'unlogged', es: 'sin imputar' },
  privateMeeting: { en: 'Meeting (private)', es: 'Reunión (privada)' },
  more: { en: 'more', es: 'más' },
} satisfies Record<string, Localized>;
