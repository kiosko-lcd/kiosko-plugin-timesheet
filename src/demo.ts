/** Sample data for the editor and the gallery: made-up people and projects. */
import type { ProjectActivity } from './activity.ts';
import type { LoggedEntry, MeetingLike } from './focus.ts';
import { addDays, localDay, mondayOf, type TimelogRow } from './timesheet.ts';
import type { ActivityData, TimelogsData } from './index.ts';

const at = (day: string, h: number) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).getTime();

export function demoTimelogs(now: number): TimelogsData {
  const today = localDay(now);
  const from = addDays(mondayOf(today), -28);
  const people: [string, number][] = [['you', 7.6], ['sam.lee', 8], ['alex_m', 6.5], ['jordan', 7.2]];
  const rows: TimelogRow[] = [];
  people.forEach(([user, base], k) => {
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const dow = new Date(`${d}T12:00:00`).getDay();
      if (dow === 0 || dow === 6) continue;
      const wobble = ((d.charCodeAt(9) * 7 + k * 13) % 9) / 10 - 0.4;
      const hours = d === today ? Math.max(0, base * 0.45 + wobble - k * 0.8) : base + wobble + (k === 2 && d >= mondayOf(today) ? -2.5 : 0);
      if (hours > 0) rows.push({ user, at: at(d, 15), hours });
    }
  });
  const meetingAt = new Date(now);
  meetingAt.setHours(9, 30, 0, 0);
  const entries: LoggedEntry[] = [
    { hours: 0.25, spentAt: meetingAt.getTime(), summary: `Meeting: Daily [cal ${today} 09:30]`, project: 'acme/meetings', ref: 'acme/meetings#1' },
    { hours: 1.5, spentAt: at(today, 10), summary: 'Rate limits', project: 'acme/api', ref: 'acme/api!88' },
    { hours: 1, spentAt: at(today, 12), summary: 'Review', project: 'acme/web-app', ref: 'acme/web-app!412' },
  ];
  return { me: 'you', weeks: 4, rows, today: { day: today, entries } };
}

export function demoActivity(now: number): ActivityData {
  const today = localDay(now);
  const b = (h1: number, m1: number, min: number) => {
    const s = new Date(now);
    s.setHours(h1, m1, 0, 0);
    return { start: s.getTime(), end: s.getTime() + min * 60_000 };
  };
  const projects: ProjectActivity[] = [
    { project: 'web-app', blocks: [b(10, 30, 95), b(13, 0, 40)], total: 135 * 60_000 },
    { project: 'api', blocks: [b(9, 45, 110)], total: 110 * 60_000 },
    { project: 'docs', blocks: [b(12, 20, 10)], total: 10 * 60_000 },
  ];
  return { day: today, projects };
}

export function demoMeetings(now: number): MeetingLike[] {
  const m = (title: string, h: number, min: number, len: number): MeetingLike => {
    const s = new Date(now);
    s.setHours(h, min, 0, 0);
    return { title, startsAt: s.getTime(), endsAt: s.getTime() + len * 60_000 };
  };
  return [m('Daily', 9, 30, 15), m('Sprint planning', 11, 0, 60), m('Design review', 16, 0, 45)].map((x, i) => (i === 1 ? { ...x, endsAt: Math.min(x.endsAt, now - 60_000), startsAt: Math.min(x.startsAt, now - 61 * 60_000) } : x));
}
