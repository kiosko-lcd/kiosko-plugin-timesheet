import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin, { activityByProject, dayKey, fetchMyTimelogs, focusView, meetingMarker, meetingsToday, minutesText, parseMyTimelogs, readActivity, workdayOf, type ActivityEvent } from './index.ts';

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
  assert.equal(minutesText(90), '1 h 30 min');
  assert.equal(minutesText(45), '45 min');
  assert.equal(minutesText(120), '2 h');
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

test('workday options map to a Workday', () => {
  const base = { start: '08:00', end: '16:00', hours: 7.5, weekly: 37.5, fridayEnd: '', fridayHours: 0, holidays: [] };
  assert.equal(workdayOf(base).friday, undefined);
  assert.deepEqual(workdayOf({ ...base, fridayEnd: '14:00' }).friday, { end: '14:00', hours: 7.5 });
});

test('plugin: widgets and sources, demos that render without credentials', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { THEMES } = await import('@kiosko/sdk');
  const kit = await import('@loksly/lcd-canvas-kit');
  assert.equal(plugin.id, 'timesheet');
  assert.deepEqual(plugin.widgets!.map((w) => w.id), ['hours', 'focus']);
  assert.deepEqual(plugin.sources!.map((s) => s.id), ['timelogs', 'activity']);
  const now = new Date(2026, 10, 9, 14, 0).getTime();
  for (const w of plugin.widgets!) {
    const options = Object.fromEntries(Object.entries((w.options as { props: Record<string, { default: unknown }> }).props).map(([k, f]) => [k, f.default]));
    const demo = w.demo!({ options, now, locale: 'es' });
    const canvas = createCanvas(600, 420);
    const g = canvas.getContext('2d');
    const theme = THEMES[0]!;
    w.render(g as never, { options, data: undefined, sources: demo.sources ?? {}, now, working: true, box: { x: 10, y: 10, w: 580, h: 400 }, theme, fonts: theme.fonts, kit, canvas: { createCanvas }, preview: true, locale: 'es', t: (x: { es: string }) => x.es } as never);
    assert.ok(w.visible!({ options, data: undefined, sources: demo.sources ?? {}, now, working: true } as never), w.id);
  }
});
