import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORKDAY, type Workday } from '@kiosko/sdk';
import { addDays, dayShape, daysBetween, expectedHours, fetchRows, graphqlUrl, hoursRound, hoursText, inWorkday, localDay, localMinutes, minutesToEnd, mondayOf, parseTimelogPage, shortName, summarize, timelogQuery, trendOf, weekdayOf, weekHours, whoAmI, windowStart, workFractions, type TimelogRow } from './index.ts';

const TZ = 'Europe/Madrid';
/** Thursday 2026-10-08, 17:00 in Madrid (CEST, UTC+2). */
const NOW = Date.parse('2026-10-08T15:00:00Z');
const at = (iso: string) => Date.parse(iso);

test('days are cut in local time, not UTC', () => {
  assert.equal(localDay(at('2026-10-07T23:30:00Z'), TZ), '2026-10-08');
  assert.equal(localDay(at('2026-10-07T21:30:00Z'), TZ), '2026-10-07');
});

test('Monday of the week and window from the Monday before', () => {
  assert.equal(mondayOf('2026-10-08'), '2026-10-05');
  assert.equal(mondayOf('2026-10-11'), '2026-10-05');
  assert.equal(windowStart(NOW, 1, TZ), '2026-09-28');
  assert.equal(windowStart(NOW, 4, TZ), '2026-09-07');
  assert.equal(weekdayOf('2026-10-04'), 0);
  assert.equal(weekdayOf('2026-10-05'), 1);
  assert.equal(dayShape(DEFAULT_WORKDAY, '2026-10-04').working, false);
  assert.equal(dayShape(DEFAULT_WORKDAY, '2026-10-05').working, true);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(daysBetween('2026-09-28', '2026-10-04'), 6);
});

test('the four figures: today, week, weekday average and weekly average', () => {
  const rows: TimelogRow[] = [
    { user: 'me', at: at('2026-10-08T08:00:00Z'), hours: 3 },
    { user: 'me', at: at('2026-10-07T23:30:00Z'), hours: 1 }, // 01:30 on the 8th: today
    { user: 'me', at: at('2026-10-05T08:00:00Z'), hours: 6 },
    { user: 'me', at: at('2026-09-28T09:00:00Z'), hours: 6 },
    { user: 'me', at: at('2026-09-22T09:00:00Z'), hours: 8 },
    { user: 'me', at: at('2026-10-04T09:00:00Z'), hours: 4 }, // Sunday: weekly only
    { user: 'me', at: at('2026-09-20T09:00:00Z'), hours: 50 }, // outside the period
    { user: 'ana.perez', at: at('2026-10-06T09:00:00Z'), hours: 7 },
  ];
  const v = summarize(rows, { now: NOW, me: 'me', weeks: 2, timeZone: TZ });
  assert.equal(v.day, '2026-10-08');
  const [me, ana] = v.people;
  assert.deepEqual(me, { user: 'me', me: true, today: 4, week: 10, dayAvg: 14 / 10, weekAvg: 9, trend: 'up' });
  assert.deepEqual(ana, { user: 'ana.perez', me: false, today: 0, week: 7, dayAvg: null, weekAvg: null, trend: 'up' });
});

test('trend: this week at its pace against the weekly average', () => {
  assert.equal(trendOf(20, 0.5, 40), 'steady');
  assert.equal(trendOf(20, 0.5, 35), 'steady');
  assert.equal(trendOf(20, 0.5, 34), 'up');
  assert.equal(trendOf(10, 0.5, 40), 'down');
  assert.equal(trendOf(3, 0.5, null), 'up');
  assert.equal(trendOf(0, 0.5, null), null);
  assert.equal(trendOf(2, 0.05, 40), null);
});

test('you show up first even with nothing logged; then by hours today', () => {
  const rows: TimelogRow[] = [
    { user: 'c', at: at('2026-10-08T08:00:00Z'), hours: 1 },
    { user: 'd', at: at('2026-10-08T08:00:00Z'), hours: 5 },
  ];
  const v = summarize(rows, { now: NOW, me: 'me', weeks: 4, timeZone: TZ });
  assert.deepEqual(v.people.map((p) => p.user), ['me', 'd', 'c']);
});

test('short names, aliases and number formats', () => {
  assert.equal(shortName('jordan.smith'), 'jor');
  assert.equal(shortName('mpar_bav'), 'mpa');
  assert.equal(shortName('albert', { albert: 'Albert C.' }), 'Albert C.');
  assert.equal(hoursText(4.25, 'es'), '4,3');
  assert.equal(hoursText(4.25, 'en'), '4.3');
  assert.equal(hoursRound(33.4), '33');
});

test('parses a page (group or top-level) and its cursor; GraphQL errors throw', () => {
  const tl = { pageInfo: { hasNextPage: true, endCursor: 'X' }, nodes: [
    { timeSpent: 5400, spentAt: '2026-10-08T08:00:00Z', user: { username: 'a' } },
    { timeSpent: 60, spentAt: 'junk', user: { username: 'a' } },
  ] };
  const { rows, next } = parseTimelogPage(JSON.stringify({ data: { group: { timelogs: tl } } }));
  assert.deepEqual(rows, [{ user: 'a', at: at('2026-10-08T08:00:00Z'), hours: 1.5 }]);
  assert.equal(next, 'X');
  assert.equal(parseTimelogPage(JSON.stringify({ data: { timelogs: tl } })).rows.length, 1);
  assert.throws(() => parseTimelogPage(JSON.stringify({ errors: [{ message: 'forbidden' }] })), /forbidden/);
  assert.throws(() => parseTimelogPage(JSON.stringify({ data: { group: null } })), /group/);
});

test('fetchRows pages with the cursor from the Sunday before the period; without a group, only yours', async () => {
  const queries: string[] = [];
  const pages = [
    { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ timeSpent: 3600, spentAt: '2026-10-08T08:00:00Z', user: { username: 'me' } }] },
    { pageInfo: { hasNextPage: false }, nodes: [{ timeSpent: 7200, spentAt: '2026-10-08T09:00:00Z', user: { username: 'me' } }] },
  ];
  const rows = await fetchRows(async (q) => (queries.push(q), JSON.stringify({ data: { group: { timelogs: pages[queries.length - 1] } } })), { group: 'g', username: 'me', weeks: 4, now: NOW, timeZone: TZ });
  assert.equal(rows.length, 2);
  assert.match(queries[0]!, /fullPath: "g"/);
  assert.match(queries[0]!, /startDate: "2026-09-06"/);
  assert.doesNotMatch(queries[0]!, /username: /);
  assert.match(queries[1]!, /after: "c1"/);
  assert.match(timelogQuery({ username: 'me', start: 'd' }), /^\{ timelogs\(username: "me"/);
});

test('connection helpers', async () => {
  assert.equal(graphqlUrl(''), 'https://gitlab.com/api/graphql');
  assert.equal(graphqlUrl('git.acme.io/'), 'https://git.acme.io/api/graphql');
  assert.equal(await whoAmI(async () => '{"data":{"currentUser":{"username":"me"}}}'), 'me');
  await assert.rejects(whoAmI(async () => '{"data":{"currentUser":null}}'), /not logged in/);
});

const week = (o: Partial<Workday> = {}): Workday => ({ ...DEFAULT_WORKDAY, ...o });

test('what is due, from the working week: the day in a straight line, 40 h Monday to Friday', () => {
  const w = week({ start: '09:00', end: '16:30', hours: 8 });
  const exp = (iso: string) => expectedHours(at(iso), w, TZ);
  assert.equal(localMinutes(at('2026-10-08T10:45:00Z'), TZ), 12 * 60 + 45);
  assert.deepEqual(exp('2026-10-05T06:00:00Z'), { today: 0, week: 0 });
  assert.deepEqual(exp('2026-10-07T07:00:00Z'), { today: 0, week: 16 });
  assert.deepEqual(exp('2026-10-08T10:45:00Z'), { today: 4, week: 28 });
  assert.deepEqual(exp('2026-10-09T16:00:00Z'), { today: 8, week: 40 });
  assert.deepEqual(exp('2026-10-10T10:00:00Z'), { today: 0, week: 40 });
  assert.deepEqual(workFractions(at('2026-10-07T11:00:00Z'), week(), TZ), { day: 0.5, week: 0.5 });
});

test('working week: a short Friday (byDay) and holidays', () => {
  const w = week({ start: '09:00', end: '16:30', hours: 7.5, byDay: { '5': { end: '15:00', hours: 6 } }, holidays: ['2026-10-12'] });
  assert.equal(inWorkday(at('2026-10-09T12:59:00Z'), w, TZ), true);
  assert.equal(inWorkday(at('2026-10-09T13:00:00Z'), w, TZ), false);
  assert.equal(minutesToEnd(at('2026-10-09T12:30:00Z'), w, TZ), 30);
  assert.equal(minutesToEnd(at('2026-10-10T12:30:00Z'), w, TZ), null);
  assert.deepEqual(expectedHours(at('2026-10-09T10:00:00Z'), w, TZ), { today: 3, week: 33 });
  assert.deepEqual(weekHours(w, '2026-10-14'), [0, 7.5, 7.5, 7.5, 6, 0, 0]);
  assert.equal(inWorkday(at('2026-10-12T10:00:00Z'), w, TZ), false);
  assert.deepEqual(expectedHours(at('2026-10-12T10:00:00Z'), w, TZ), { today: 0, week: 0 });
});

test('working week: four days, or Saturdays, change what is due and the daily average', () => {
  const four = week({ days: [1, 2, 3, 4], hours: 9 });
  assert.deepEqual(expectedHours(at('2026-10-09T10:00:00Z'), four, TZ), { today: 0, week: 36 }, 'Friday off: nothing due today');
  assert.equal(inWorkday(at('2026-10-09T10:00:00Z'), four, TZ), false);
  const sat = week({ days: [1, 2, 3, 4, 5, 6], byDay: { '6': { end: '13:00', hours: 4 } } });
  assert.deepEqual(expectedHours(at('2026-10-10T09:00:00Z'), sat, TZ), { today: 2, week: 42 });
  // Two weeks of four 9-hour days, all logged on Mondays: 8 working days.
  const rows: TimelogRow[] = [
    { user: 'me', at: at('2026-09-21T09:00:00Z'), hours: 36 },
    { user: 'me', at: at('2026-09-28T09:00:00Z'), hours: 36 },
    { user: 'me', at: at('2026-10-02T09:00:00Z'), hours: 5 }, // a Friday: not a working day, weekly only
  ];
  const me = summarize(rows, { now: NOW, me: 'me', weeks: 2, timeZone: TZ, workday: four }).people[0]!;
  assert.equal(me.dayAvg, 72 / 8);
  assert.equal(me.weekAvg, 77 / 2);
  // A holiday in the period is not a working day either.
  const off = summarize(rows, { now: NOW, me: 'me', weeks: 2, timeZone: TZ, workday: week({ holidays: ['2026-09-22', '2026-09-23'] }) }).people[0]!;
  assert.equal(off.dayAvg, (36 + 36 + 5) / 8);
});
