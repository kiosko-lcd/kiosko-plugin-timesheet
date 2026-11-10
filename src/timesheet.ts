/**
 * Hours logged in GitLab: yours and the rest of your group's.
 *
 * Four figures per person:
 *
 *   - **today**: logged with today's date. Provisional by nature, since many
 *     people log the next day;
 *   - **week**: logged in the current week, Monday to today;
 *   - **daily average**: over the `weeks` complete weeks before this one, the
 *     hours of working days divided by the number of working days, both from
 *     the user's working week (`ctx.workday`). Days off (weekends, holidays)
 *     count neither in hours nor in days;
 *   - **weekly average**: over those same weeks, the mean total per week,
 *     weekend included.
 *
 * Days are cut in local time, not UTC: GitLab returns `spentAt` in UTC, and
 * what is logged between 00:00 and 02:00 in summer would otherwise fall on the
 * previous day.
 *
 * Plus each person's **trend** against themselves: the current week, at the
 * pace it is going, against their own weekly average. It compares nobody with
 * anybody, so it works even if everyone counts hours their own way.
 */
import { DEFAULT_WORKDAY, minutesOf, type Workday } from '@kiosko/sdk';
import { dataOf, type GraphQL } from './gitlab.ts';

export interface TimelogRow {
  user: string;
  /** When it was spent, ms epoch. */
  at: number;
  /** Hours. */
  hours: number;
}

export type Trend = 'up' | 'steady' | 'down';

export interface PersonHours {
  user: string;
  me: boolean;
  today: number;
  /** Current week, Monday to today. */
  week: number;
  /** Mean per weekday over the period; null if nothing was logged in it. */
  dayAvg: number | null;
  /** Mean per week over the period; null if nothing was logged in it. */
  weekAvg: number | null;
  trend: Trend | null;
}

export interface TimesheetView {
  /** Local day (YYYY-MM-DD) that `today` refers to. */
  day: string;
  people: PersonHours[];
}

/** Relative difference under which the trend is steady. */
export const TREND_BAND = 0.15;
/** Below this part of the working week there is no pace to measure yet. */
export const TREND_MIN_FRACTION = 0.1;

/**
 * This week so far, extrapolated to a whole week at its pace
 * (`week / fraction`), against the weekly average. Without an average: up if
 * something is logged already; with no pace yet (early Monday), null.
 */
export function trendOf(week: number, fraction: number, weekAvg: number | null): Trend | null {
  if (fraction < TREND_MIN_FRACTION) return null;
  if (!weekAvg) return week > 0 ? 'up' : null;
  const rel = week / fraction / weekAvg - 1;
  return rel > TREND_BAND ? 'up' : rel < -TREND_BAND ? 'down' : 'steady';
}

/** YYYY-MM-DD in the given time zone (or the system's). */
export function localDay(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** Adds `n` days to a YYYY-MM-DD date, without going through time zones. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Days from `a` to `b` (YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Monday of the week of `day` (ISO week, Monday to Sunday). */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** First day that has to be fetched: the Monday `weeks` weeks back. */
export function windowStart(now: number, weeks: number, timeZone?: string): string {
  return addDays(mondayOf(localDay(now, timeZone)), -7 * weeks);
}

/** Day of the week of a YYYY-MM-DD date, 0 = Sunday … 6 = Saturday (as `Workday.days`). */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Minutes since local midnight. */
export function localMinutes(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

export interface DayShape {
  /** A working day of the week that is not a holiday. */
  working: boolean;
  /** Minutes from midnight. */
  startMin: number;
  endMin: number;
  /** Hours due: 0 on days off. */
  hours: number;
}

/**
 * The working day of a date (YYYY-MM-DD) in the user's week: like the SDK's
 * `scheduleOn`, but for a day already cut in the right time zone.
 */
export function dayShape(w: Workday, day: string): DayShape {
  const own = w.byDay?.[String(weekdayOf(day))] ?? {};
  const working = w.days.includes(weekdayOf(day)) && !(w.holidays ?? []).includes(day);
  return { working, startMin: minutesOf(own.start || w.start), endMin: minutesOf(own.end || w.end), hours: working ? (own.hours ?? w.hours ?? 0) : 0 };
}

/** Hours due on each day of the week of `day`, Monday first; days off at 0. */
export function weekHours(w: Workday, day: string): number[] {
  const monday = mondayOf(day);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => dayShape(w, addDays(monday, i)).hours);
}

/** Is it working time now? A working day, between its start and end. */
export function inWorkday(now: number, w: Workday, timeZone?: string): boolean {
  const shape = dayShape(w, localDay(now, timeZone));
  const m = localMinutes(now, timeZone);
  return shape.working && m >= shape.startMin && m < shape.endMin;
}

/** Minutes left until today's end of work; null outside working time. */
export function minutesToEnd(now: number, w: Workday, timeZone?: string): number | null {
  if (!inWorkday(now, w, timeZone)) return null;
  return dayShape(w, localDay(now, timeZone)).endMin - localMinutes(now, timeZone);
}

/**
 * What part of today's working day and of the working week has gone by, 0..1.
 * The week goes by hours due: a short Friday weighs less than a Monday, a day
 * off nothing. On a day off the day doesn't count (0) and the week is what
 * the days before it make (all of it at the weekend).
 */
export function workFractions(now: number, w: Workday, timeZone?: string): { day: number; week: number } {
  const day = localDay(now, timeZone);
  const idx = daysBetween(mondayOf(day), day);
  const shape = dayShape(w, day);
  const frac = !shape.working ? 0 : shape.endMin > shape.startMin ? Math.min(1, Math.max(0, (localMinutes(now, timeZone) - shape.startMin) / (shape.endMin - shape.startMin))) : 1;
  const hours = weekHours(w, day);
  const total = hours.reduce((a, b) => a + b, 0);
  const before = hours.slice(0, idx).reduce((a, b) => a + b, 0);
  return { day: frac, week: total ? (before + frac * hours[idx]!) / total : 1 };
}

/**
 * What you should have logged by now, today and this week, spread in a
 * straight line: each day's hours between its start and end, the week's as
 * the days go by. Holidays ask for nothing.
 */
export function expectedHours(now: number, w: Workday, timeZone?: string): { today: number; week: number } {
  const day = localDay(now, timeZone);
  const idx = daysBetween(mondayOf(day), day);
  const hours = weekHours(w, day);
  const { day: frac } = workFractions(now, w, timeZone);
  const today = hours[idx]! * frac;
  return { today, week: hours.slice(0, idx).reduce((a, b) => a + b, 0) + today };
}

/** `jane.doe` → `jan`: three letters are enough to recognise a teammate. Aliases win, whole. */
export function shortName(user: string, aliases: Record<string, string> = {}): string {
  return aliases[user] ?? (user.split(/[._]/)[0] || user).slice(0, 3);
}

export interface SummaryOptions {
  now: number;
  me: string;
  /** Complete weeks, before the current one, the averages are taken over. */
  weeks: number;
  /** Working days (for the daily average) and the week's pace (for the trend). Default: Monday to Friday, 9 to 17. */
  workday?: Workday;
  timeZone?: string;
}

export function summarize(rows: TimelogRow[], o: SummaryOptions): TimesheetView {
  const weeks = Math.max(1, Math.round(o.weeks));
  const today = localDay(o.now, o.timeZone);
  const monday = mondayOf(today);
  const from = addDays(monday, -7 * weeks);
  const perDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const day = localDay(r.at, o.timeZone);
    const days = perDay.get(r.user) ?? new Map<string, number>();
    days.set(day, (days.get(day) ?? 0) + r.hours);
    perDay.set(r.user, days);
  }
  // You always show up, even before logging anything.
  if (o.me && !perDay.has(o.me)) perDay.set(o.me, new Map());
  const w = o.workday ?? DEFAULT_WORKDAY;
  const fraction = workFractions(o.now, w, o.timeZone).week;
  // Working days of the averaging period: the daily average is per working day.
  const working = new Set<string>();
  for (let d = from; d < monday; d = addDays(d, 1)) if (dayShape(w, d).working) working.add(d);
  const people: PersonHours[] = [];
  for (const [user, days] of perDay) {
    let week = 0, total = 0, onWorkdays = 0, any = false;
    for (const [day, h] of days) {
      if (day >= monday && day <= today) week += h;
      else if (day >= from && day < monday) {
        total += h;
        if (working.has(day)) onWorkdays += h;
        any = true;
      }
    }
    const weekAvg = any ? total / weeks : null;
    const dayAvg = any && working.size ? onWorkdays / working.size : null;
    people.push({ user, me: user === o.me, today: days.get(today) ?? 0, week, dayAvg, weekAvg, trend: trendOf(week, fraction, weekAvg) });
  }
  people.sort((a, b) => Number(b.me) - Number(a.me) || b.today - a.today || b.week - a.week || a.user.localeCompare(b.user));
  return { day: today, people };
}

/**
 * One page of timelogs since `start`: the group's when `group` is set, or else
 * just `username`'s (GitLab's top-level query needs one of the two).
 */
export function timelogQuery(o: { group?: string; username?: string; start: string; after?: string }): string {
  const cursor = o.after ? `, after: ${JSON.stringify(o.after)}` : '';
  const who = o.username ? `username: ${JSON.stringify(o.username)}, ` : '';
  const body = `timelogs(${who}startDate: ${JSON.stringify(o.start)}, first: 100${cursor}) { pageInfo { hasNextPage endCursor } nodes { timeSpent spentAt user { username } } }`;
  return o.group ? `{ group(fullPath: ${JSON.stringify(o.group)}) { ${body} } }` : `{ ${body} }`;
}

type Timelogs = { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: { timeSpent?: number; spentAt?: string; user?: { username?: string } }[] };

export function parseTimelogPage(json: string): { rows: TimelogRow[]; next: string | null } {
  const data = dataOf<{ group?: { timelogs?: Timelogs } | null; timelogs?: Timelogs }>(json);
  const tl = data && 'group' in data ? data.group?.timelogs : data?.timelogs;
  if (!tl) throw new Error('the group does not exist or its timelogs cannot be read');
  const rows: TimelogRow[] = [];
  for (const n of tl.nodes ?? []) {
    const at = Date.parse(n.spentAt ?? '');
    if (!n.user?.username || !Number.isFinite(at) || typeof n.timeSpent !== 'number') continue;
    rows.push({ user: n.user.username, at, hours: n.timeSpent / 3600 });
  }
  return { rows, next: tl.pageInfo?.hasNextPage && tl.pageInfo.endCursor ? tl.pageInfo.endCursor : null };
}

/** A cap on pages: a big group must not keep the source spinning. */
const MAX_PAGES = 30;

/** Every page of timelogs since the day before the averaging window (GitLab dates are UTC; the fine cut is local). */
export async function fetchRows(gql: GraphQL, o: { group?: string; username?: string; weeks: number; now: number; timeZone?: string }): Promise<TimelogRow[]> {
  const start = addDays(windowStart(o.now, o.weeks, o.timeZone), -1);
  const rows: TimelogRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows: got, next } = parseTimelogPage(await gql(timelogQuery({ group: o.group || undefined, username: o.group ? undefined : o.username, start, after })));
    rows.push(...got);
    if (!next) break;
    after = next;
  }
  return rows;
}

const decimals = new Map<string, Intl.NumberFormat>();

/** `4.25` → `4.3` (`4,3` in Spanish): one decimal, in the language's own notation. */
export function hoursText(h: number, locale = 'en'): string {
  let f = decimals.get(locale);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
    } catch {
      f = new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
    }
    decimals.set(locale, f);
  }
  return f.format(h);
}

/** Weekly totals to the hour: `33.4` → `33`. Four columns don't fit decimals. */
export function hoursRound(h: number): string {
  return String(Math.round(h));
}
