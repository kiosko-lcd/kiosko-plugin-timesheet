import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, expectedHours, fetchRows, graphqlUrl, hoursRound, hoursText, inWorkday, isWeekend, localDay, localMinutes, minutesToEnd, mondayOf, parseClock, parseTimelogPage, shortName, summarize, timelogQuery, trendOf, whoAmI, windowStart, workFractions, type TimelogRow } from './index.ts';

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
  assert.equal(isWeekend('2026-10-04'), true);
  assert.equal(isWeekend('2026-10-05'), false);
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

test('what is due: the day in a straight line, 40 h Monday to Friday', () => {
  const w = { start: '09:00', end: '16:30', hours: 7.5, weekly: 40 };
  const exp = (iso: string) => expectedHours(at(iso), w, TZ);
  assert.equal(parseClock('16:30'), 990);
  assert.equal(localMinutes(at('2026-10-08T10:45:00Z'), TZ), 12 * 60 + 45);
  assert.deepEqual(exp('2026-10-05T06:00:00Z'), { today: 0, week: 0 });
  assert.deepEqual(exp('2026-10-07T07:00:00Z'), { today: 0, week: 16 });
  assert.deepEqual(exp('2026-10-08T10:45:00Z'), { today: 3.75, week: 28 });
  assert.deepEqual(exp('2026-10-09T16:00:00Z'), { today: 7.5, week: 40 });
  assert.deepEqual(exp('2026-10-10T10:00:00Z'), { today: 0, week: 40 });
  assert.deepEqual(workFractions(at('2026-10-07T11:00:00Z'), { start: '09:00', end: '17:00' }, TZ), { day: 0.5, week: 0.5 });
});

test('workday: a short Friday and holidays', () => {
  const w = { start: '09:00', end: '16:30', hours: 7.5, weekly: 40, friday: { end: '15:00', hours: 6 }, holidays: ['2026-10-12'] };
  assert.equal(inWorkday(at('2026-10-09T12:59:00Z'), w, TZ), true);
  assert.equal(inWorkday(at('2026-10-09T13:00:00Z'), w, TZ), false);
  assert.equal(minutesToEnd(at('2026-10-09T12:30:00Z'), w, TZ), 30);
  assert.equal(minutesToEnd(at('2026-10-10T12:30:00Z'), w, TZ), null);
  const e = expectedHours(at('2026-10-09T10:00:00Z'), w, TZ);
  assert.equal(e.today, 3);
  assert.ok(Math.abs(e.week - (40 * 33) / 36) < 1e-9);
  assert.equal(inWorkday(at('2026-10-12T10:00:00Z'), w, TZ), false);
  assert.deepEqual(expectedHours(at('2026-10-12T10:00:00Z'), w, TZ), { today: 0, week: 0 });
});
