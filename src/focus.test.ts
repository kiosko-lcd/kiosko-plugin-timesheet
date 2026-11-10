import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as realKit from '@loksly/lcd-canvas-kit';
import { createBaseContext, DEFAULT_THEME, DEFAULT_WORKDAY, validate, type WidgetDefinition, type Workday } from '@kiosko/sdk';
import { demoActivity, demoMeetings, demoTimelogs } from './demo.ts';
import plugin, { activityByProject, columnsOf, dayKey, fetchMyTimelogs, focus, focusView, hours, meetingMarker, meetingsToday, parseMyTimelogs, readActivity, type ActivityEvent, type TimelogsData } from './index.ts';

const MIN = 60_000;
const t = (h: number, m = 0) => new Date(2026, 9, 13, h, m).getTime();

test('focus: today\'s timelogs with their issue or MR', async () => {
  const body = JSON.stringify({ data: { timelogs: { nodes: [
    { timeSpent: 5400, spentAt: '2026-10-13T08:00:00Z', summary: 'Meeting: Daily [cal 2026-10-13 10:00]', project: { fullPath: 'acme/meet' }, issue: { reference: 'acme/meet#6' }, mergeRequest: null },
    { timeSpent: 1800, spentAt: '2026-10-13T09:00:00Z', summary: null, project: { fullPath: 'acme/api' }, issue: null, mergeRequest: { reference: 'acme/api!17' } },
    { timeSpent: 60, spentAt: 'no', project: {} },
  ] } } });
  const qs: string[] = [];
  const rows = await fetchMyTimelogs(async (q) => (qs.push(q), body), 'me', '2026-10-13', '2026-10-14');
  assert.ok(qs[0]!.includes('username: "me", startDate: "2026-10-13", endDate: "2026-10-14"'));
  assert.deepEqual(rows.map((r) => [r.hours, r.ref, r.summary]), [[1.5, 'acme/meet#6', 'Meeting: Daily [cal 2026-10-13 10:00]'], [0.5, 'acme/api!17', '']]);
  assert.throws(() => parseMyTimelogs(JSON.stringify({ errors: [{ message: 'forbidden' }] })), /forbidden/);
});

test('focus: finished meetings without their marker, projects with unlogged activity', () => {
  const daily = { title: 'Daily', startsAt: t(10), endsAt: t(10, 15) };
  const sync = { title: 'Sync', startsAt: t(11), endsAt: t(12) };
  const later = { title: 'Later', startsAt: t(15), endsAt: t(16) };
  assert.equal(meetingMarker(daily), '[cal 2026-10-13 10:00]');
  const v = focusView({
    now: t(13),
    meetings: [sync, daily, later],
    logged: [
      { hours: 0.25, spentAt: t(10), summary: `Meeting: Daily ${meetingMarker(daily)}`, project: 'acme/meet', ref: null },
      { hours: 1, spentAt: t(9), summary: 'fix', project: 'acme/web-app', ref: 'acme/web-app!1' },
    ],
    activity: [{ project: 'web-app', total: 150 * MIN }, { project: 'kiosko', total: 40 * MIN }, { project: 'other', total: 10 * MIN }],
    expected: 3.5,
  });
  assert.deepEqual(v.meetings.map((m) => m.title), ['Sync']);
  assert.deepEqual(v.projects.map((p) => [p.project, p.activity, p.logged, p.pending]), [['web-app', 150, 60, 90], ['kiosko', 40, 0, 40]]);
  assert.equal(v.logged, 1.25);
  const strict = focusView({ now: t(13), meetings: [], logged: [], activity: [{ project: 'kiosko', total: 40 * MIN }], expected: 0, minPendingMs: 45 * MIN });
  assert.deepEqual(strict.projects, [], 'under minPendingMs: not proposed');
});

test('focus: only today\'s meetings from the calendar source', () => {
  assert.deepEqual(meetingsToday([{ title: 'a', startsAt: t(9), endsAt: t(10) }, { title: 'b', startsAt: t(9) + 86_400_000, endsAt: t(10) + 86_400_000 }], t(12)).map((m) => m.title), ['a']);
  assert.deepEqual(meetingsToday(undefined, t(12)), []);
});

const at9 = t(9);
const ev = (min: number, project: string, provider = 'claude'): ActivityEvent => ({ at: at9 + min * MIN, session: 's', provider, project, state: 'active', event: 'PreToolUse' });

test('activity: one line per event; broken lines and calls are skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'act-'));
  writeFileSync(join(dir, `${dayKey(at9)}.jsonl`), [ev(0, 'a'), ev(5, 'a'), ev(6, 'x', 'llamada')].map((e) => JSON.stringify(e)).join('\n') + '\n{"at": 12, "proj');
  assert.deepEqual((await readActivity(dayKey(at9), dir)).map((e) => e.project), ['a', 'a']);
  assert.deepEqual(await readActivity('2020-01-01', dir), []);
});

test('activity: blocks per project with gaps under 15 min, plus 5 of tail', () => {
  const [a, b] = activityByProject([ev(0, 'a'), ev(10, 'a'), ev(20, 'a'), ev(60, 'a'), ev(30, 'b')]);
  assert.deepEqual(a!.blocks.map((x) => [(x.start - at9) / MIN, (x.end - at9) / MIN]), [[0, 25], [60, 65]]);
  assert.equal(a!.total, 30 * MIN);
  assert.equal(b!.total, 5 * MIN);
  assert.deepEqual(activityByProject([]), []);
});

/** Renders a widget and returns every text it drew, in order. */
function texts(w: WidgetDefinition<any, any>, options: Record<string, unknown>, sources: Record<string, unknown>, o: { now: number; size?: { w: number; h: number }; locale?: string; workday?: Workday }): string[] {
  const out: string[] = [];
  const kit = { ...realKit, drawTracked: (...a: Parameters<typeof realKit.drawTracked>) => (out.push(a[1]), realKit.drawTracked(...a)) };
  const size = o.size ?? { w: 600, h: 420 };
  const canvas = createCanvas(size.w, size.h);
  const theme = DEFAULT_THEME;
  w.render(canvas.getContext('2d'), {
    ...createBaseContext({ now: o.now, locale: o.locale ?? 'en', ...(o.workday ? { workday: o.workday } : {}) }), options: validate(w.options!, options).value, data: undefined, sources, working: true,
    box: { x: 0, y: 0, w: size.w, h: size.h }, theme, fonts: theme.fonts, kit, canvas: { createCanvas, loadImage: (() => {}) as never }, preview: false,
  } as never);
  return out;
}

/** Thursday 2026-11-05, 14:00 local. */
const NOW = new Date(2026, 10, 5, 14, 0).getTime();
const tl = demoTimelogs(NOW);
const team = (n: number): TimelogsData => ({ ...tl, rows: [...tl.rows, ...Array.from({ length: n }, (_, i) => ({ user: `extra${i}`, at: NOW - 3_600_000, hours: 1 }))] });

test('hours: columns in the user\'s order, each once; empty = all', () => {
  assert.deepEqual(columnsOf([]), ['today', 'week', 'dayAvg', 'weekAvg', 'trend']);
  assert.deepEqual(columnsOf(['week', 'today', 'week', 'nope']), ['week', 'today']);
  const heads = (cols: string[]) => texts(hours, { columns: cols }, { 'timesheet/timelogs': tl }, { now: NOW }).filter((x) => ['today', 'wk', 'h/day', 'h/wk'].includes(x));
  assert.deepEqual(heads([]), ['today', 'wk', 'h/day', 'h/wk']);
  assert.deepEqual(heads(['week', 'today']), ['wk', 'today']);
});

test('hours: the people filter (by username or alias), rows and "+N more"', () => {
  const names = (o: Record<string, unknown>, d = tl) => texts(hours, o, { 'timesheet/timelogs': d }, { now: NOW }).filter((x) => /^(you|sam|ale|jor|Alex|extra\d+|ext)$/.test(x));
  assert.deepEqual(names({}), ['you', 'sam', 'ale', 'jor']);
  assert.deepEqual(names({ people: ['sam.*', 'alex_m'] }), ['sam', 'ale']);
  assert.deepEqual(names({ people: ['Alex'], aliases: { alex_m: 'Alex' } }), ['Alex']);
  assert.deepEqual(names({ people: ['!you'] }), ['sam', 'ale', 'jor']);
  const t = texts(hours, { rows: 4 }, { 'timesheet/timelogs': team(6) }, { now: NOW });
  assert.ok(t.includes('+6 more'), t.join('|'));
  assert.ok(texts(hours, {}, { 'timesheet/timelogs': team(20) }, { now: NOW, size: { w: 600, h: 300 } }).some((x) => /^\+\d+ more$/.test(x)));
  assert.deepEqual(texts(hours, { people: ['nobody'] }, { 'timesheet/timelogs': tl }, { now: NOW }), ['Nobody to show']);
  const state = { options: validate(hours.options!, { people: ['nobody'] }).value, data: undefined, sources: { 'timesheet/timelogs': tl }, now: NOW, working: true };
  assert.equal(hours.empty!(state as never), true);
  assert.equal(hours.empty!({ ...state, options: validate(hours.options!, {}).value } as never), false);
});

test('hours and focus: what is due comes from the working week (ctx.workday)', () => {
  const due = (w: Workday) => texts(hours, {}, { 'timesheet/timelogs': tl }, { now: NOW, workday: w }).find((x) => x.startsWith('due '));
  assert.equal(due({ ...DEFAULT_WORKDAY, start: '09:00', end: '17:00', hours: 8 }), 'due 5.0 · 29');
  assert.equal(due({ ...DEFAULT_WORKDAY, holidays: ['2026-11-05'] }), 'due 0.0 · 24');
  assert.equal(due({ ...DEFAULT_WORKDAY, days: [1, 2, 3], hours: 10 }), 'due 0.0 · 30');
  const f = texts(focus, {}, { 'timesheet/timelogs': tl, 'timesheet/activity': demoActivity(NOW), 'calendar/events': demoMeetings(NOW) }, { now: NOW, locale: 'es' });
  assert.ok(f.includes('toca 5,0 h'), f.join('|'));
});

test('focus: debt thresholds, durations from ctx.fmt, rows and "+N more"', () => {
  const src = (n: number) => ({ 'timesheet/timelogs': tl, 'timesheet/activity': { day: dayKey(NOW), projects: Array.from({ length: n }, (_, i) => ({ project: `proj${i}`, blocks: [], total: (90 - i) * MIN })) }, 'calendar/events': [] });
  let t = texts(focus, {}, src(3), { now: NOW });
  assert.ok(t.includes('1 h 30 unlogged'), t.join('|'));
  t = texts(focus, { rows: 3 }, src(8), { now: NOW });
  assert.equal(t.filter((x) => x.startsWith('proj')).length, 3);
  assert.ok(t.includes('+5 more'));
  t = texts(focus, {}, src(30), { now: NOW, size: { w: 600, h: 420 } });
  const shown = t.filter((x) => x.startsWith('proj')).length;
  assert.ok(shown > 5 && t.includes(`+${30 - shown} more`), `${shown}`);
});

test('focus: urgent after a meeting and before leaving, per the duration options', () => {
  const end = new Date(2026, 10, 5, 16, 50).getTime();
  const meeting = { title: 'Sync', startsAt: end - 30 * MIN, endsAt: end };
  const st = (now: number, o: Record<string, unknown> = {}, w = { ...DEFAULT_WORKDAY, end: '17:00' }) => ({ options: validate(focus.options!, o).value, data: undefined, sources: { 'timesheet/timelogs': { ...tl, today: { day: tl.today.day, entries: [] } }, 'calendar/events': [meeting] }, now, working: true, workday: w }) as never;
  assert.equal(focus.urgent!(st(end + 5 * MIN)), true, 'just after the meeting');
  assert.equal(focus.urgent!(st(end + 5 * MIN, { meetingGraceMs: 0, closingMs: 0 })), false, '0 = never');
  assert.equal(focus.urgent!(st(new Date(2026, 10, 5, 12, 0).getTime(), {}, DEFAULT_WORKDAY)), false);
  assert.equal(focus.urgent!(st(new Date(2026, 10, 5, 16, 40).getTime(), { meetingGraceMs: 0 })), true, 'closing time with hours owed');
});

test('plugin: widgets and sources, demos that render without credentials', () => {
  assert.equal(plugin.id, 'timesheet');
  assert.deepEqual(plugin.widgets!.map((w) => w.id), ['hours', 'focus']);
  assert.deepEqual(plugin.sources!.map((s) => s.id), ['timelogs', 'activity']);
  assert.ok((plugin.sources![0]!.minIntervalMs ?? 0) >= 60_000);
  const now = new Date(2026, 10, 9, 14, 0).getTime();
  for (const w of plugin.widgets!) {
    const options = validate(w.options!, {}).value;
    const demo = w.demo!({ options, now, locale: 'es' });
    for (const size of [w.size!.min!, w.size!.preferred!]) for (const o of [{}, { rows: 2 }, { rows: 12 }]) assert.ok(texts(w, o, demo.sources ?? {}, { now, size, locale: 'es' }).length, w.id);
    assert.ok(w.visible!({ options, data: undefined, sources: demo.sources ?? {}, now, working: true, workday: DEFAULT_WORKDAY } as never), w.id);
  }
});
