/**
 * Timesheet: the hours logged in GitLab (yours and your group's, today, this
 * week and on average) and, for today, what is still left to log: finished
 * meetings from `calendar/events` and agent activity per project.
 */
import { defineSource, definePlugin, defineWidget, t, type Localized } from '@kiosko/sdk';
import { activityByProject, dayKey, DEFAULT_ACTIVITY_DIR, readActivity, type ProjectActivity } from './activity.ts';
import { demoActivity, demoMeetings, demoTimelogs } from './demo.ts';
import { fetchMyTimelogs, focusView, minutesText, TEXT, type LoggedEntry, type MeetingLike } from './focus.ts';
import { connect, whoAmI } from './gitlab.ts';
import { addDays, expectedHours, fetchRows, hoursRound, hoursText, inWorkday, localDay, minutesToEnd, shortName, summarize, type TimelogRow, type Workday } from './timesheet.ts';

export * from './timesheet.ts';
export * from './focus.ts';
export * from './activity.ts';
export * from './gitlab.ts';

export interface TimelogsData {
  me: string;
  weeks: number;
  rows: TimelogRow[];
  /** Your own timelogs of today, with summaries (for focus). */
  today: { day: string; entries: LoggedEntry[] };
}

export interface ActivityData {
  day: string;
  projects: ProjectActivity[];
}

const TIMELOGS = 'timesheet/timelogs';
const ACTIVITY = 'timesheet/activity';
const CALENDAR = 'calendar/events';

export const timelogs = defineSource({
  id: 'timelogs',
  name: { en: 'GitLab timelogs', es: 'Imputaciones de GitLab' },
  description: {
    en: 'Hours logged in GitLab by you and your group over the last weeks, and your own entries of today, through glab or a token.',
    es: 'Las horas imputadas en GitLab por ti y tu grupo en las últimas semanas, y tus imputaciones de hoy, con glab o con un token.',
  },
  options: t.object({
    host: t.string({ placeholder: 'gitlab.com', risk: 'network', label: { en: 'GitLab host', es: 'Servidor de GitLab' }, help: { en: 'Empty = glab\'s default host (gitlab.com with a token).', es: 'Vacío = el servidor por defecto de glab (gitlab.com con token).' } }),
    token: t.string({ secret: true, label: { en: 'Access token', es: 'Token de acceso' }, help: { en: 'A personal access token with read_api. Empty = use the glab CLI and its login.', es: 'Un token personal con read_api. Vacío = usar el CLI glab y su sesión.' } }),
    group: t.string({ placeholder: 'acme/team', label: { en: 'Group', es: 'Grupo' }, help: { en: 'Full path of the GitLab group whose hours to show. Empty = only yours.', es: 'Ruta completa del grupo de GitLab cuyas horas mostrar. Vacío = sólo las tuyas.' } }),
    me: t.string({ advanced: true, label: { en: 'Your username', es: 'Tu usuario' }, help: { en: 'Empty = the logged-in user.', es: 'Vacío = el usuario con sesión iniciada.' } }),
    weeks: t.integer({ default: 4, min: 1, max: 12, label: { en: 'Weeks for the averages', es: 'Semanas para las medias' } }),
    bin: t.string({ default: 'glab', format: 'path', risk: 'exec', advanced: true, label: { en: 'glab command', es: 'Comando glab' } }),
  }),
  intervalMs: 5 * 60_000,
  async read({ options: o, signal, now }): Promise<TimelogsData> {
    const gql = connect(o, signal);
    const me = o.me.trim() || (await whoAmI(gql));
    const day = localDay(now);
    const [rows, entries] = await Promise.all([
      fetchRows(gql, { group: o.group.trim(), username: me, weeks: o.weeks, now }),
      fetchMyTimelogs(gql, me, day, addDays(day, 1)),
    ]);
    return { me, weeks: o.weeks, rows, today: { day, entries } };
  },
  demo: ({ now }) => demoTimelogs(now),
});

export const activity = defineSource({
  id: 'activity',
  name: { en: 'Agent activity', es: 'Actividad de agentes' },
  description: {
    en: 'Today\'s work blocks per project, from the agent hook\'s activity log (one JSONL file per day).',
    es: 'Los bloques de trabajo de hoy por proyecto, del registro de actividad del hook de agentes (un JSONL por día).',
  },
  options: t.object({
    dir: t.string({ default: DEFAULT_ACTIVITY_DIR, format: 'path', risk: 'path', label: { en: 'Activity folder', es: 'Carpeta de actividad' } }),
    gapMin: t.integer({ default: 15, min: 1, max: 120, unit: 'min', advanced: true, label: { en: 'Gap that splits a block', es: 'Hueco que parte un bloque' } }),
    tailMin: t.integer({ default: 5, min: 0, max: 60, unit: 'min', advanced: true, label: { en: 'Time added after the last event', es: 'Tiempo tras el último evento' } }),
  }),
  intervalMs: 2 * 60_000,
  async read({ options: o, now }): Promise<ActivityData> {
    const day = dayKey(now);
    return { day, projects: activityByProject(await readActivity(day, o.dir), o.gapMin * 60_000, o.tailMin * 60_000) };
  },
  demo: ({ now }) => demoActivity(now),
});

const clock = (def: string, label: Localized) => t.string({ default: def, placeholder: 'HH:MM', label });

/** The working day, on each widget that needs to know what is due. */
const workdayFields = () => ({
  start: clock('09:00', { en: 'Workday starts', es: 'Entrada' }),
  end: clock('17:00', { en: 'Workday ends', es: 'Salida' }),
  hours: t.number({ default: 8, min: 0, max: 24, step: 0.25, unit: 'h', label: { en: 'Hours per day', es: 'Horas por jornada' } }),
  weekly: t.number({ default: 40, min: 0, max: 80, step: 0.5, unit: 'h', label: { en: 'Hours per week', es: 'Horas por semana' } }),
  fridayEnd: t.string({ placeholder: 'HH:MM', advanced: true, label: { en: 'Friday ends', es: 'Salida del viernes' }, help: { en: 'Empty = like any other day.', es: 'Vacío = como cualquier otro día.' } }),
  fridayHours: t.number({ default: 0, min: 0, max: 24, step: 0.25, unit: 'h', advanced: true, label: { en: 'Friday hours', es: 'Horas del viernes' } }),
  holidays: t.list(t.string({ placeholder: 'YYYY-MM-DD', label: { en: 'Day', es: 'Día' } }), { advanced: true, label: { en: 'Holidays', es: 'Festivos' } }),
});

type WorkdayOptions = { start: string; end: string; hours: number; weekly: number; fridayEnd: string; fridayHours: number; holidays: string[] };
export const workdayOf = (o: WorkdayOptions): Workday => ({
  start: o.start || '09:00',
  end: o.end || '17:00',
  hours: o.hours,
  weekly: o.weekly,
  ...(o.fridayEnd.trim() ? { friday: { end: o.fridayEnd.trim(), hours: o.fridayHours || o.hours } } : {}),
  holidays: o.holidays,
});

const timelogsOf = (s: Record<string, unknown>) => s[TIMELOGS] as TimelogsData | undefined;

export const hours = defineWidget({
  id: 'hours',
  name: { en: 'Hours logged', es: 'Horas imputadas' },
  description: {
    en: 'Hours logged in GitLab by you and your group: today, this week, daily and weekly averages, and each one\'s trend against themselves. Yours turn green or red against what is due by now.',
    es: 'Las horas imputadas en GitLab por ti y tu grupo: hoy, la semana, medias diaria y semanal, y la tendencia de cada cual contra sí mismo. Las tuyas, en verde o rojo según lo que toca a esta hora.',
  },
  icon: 'clock',
  category: 'dev',
  tags: ['gitlab', 'timesheet', 'horas', 'imputación'],
  size: { min: { w: 280, h: 120 }, preferred: { w: 600, h: 300 } },
  sources: [TIMELOGS],
  options: t.object({
    ...workdayFields(),
    aliases: t.map({ advanced: true, label: { en: 'Names', es: 'Nombres' }, help: { en: 'Username → what to show. Others show their first three letters.', es: 'Usuario → lo que se muestra. El resto, sus tres primeras letras.' }, keyLabel: { en: 'Username', es: 'Usuario' }, valueLabel: { en: 'Show as', es: 'Mostrar como' } }),
  }),
  redraw: 'minute',
  visible: ({ sources }) => Boolean(timelogsOf(sources)),
  render(g, { options, sources, now, box, theme, kit, t: tr, locale }) {
    const data = timelogsOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const w = workdayOf(options);
    const v = summarize(data.rows, { now, me: data.me, weeks: data.weeks, workday: w });
    const pace = expectedHours(now, w);
    const labels = [tr({ en: 'today', es: 'hoy' }), tr({ en: 'wk', es: 'sem' }), tr({ en: 'h/day', es: 'h/día' }), tr({ en: 'h/wk', es: 'h/sem' }), ''];
    const headH = Math.min(64, box.h * 0.22);
    const rowH = Math.max(22, Math.min(64, (box.h - headH) / Math.max(2, v.people.length), box.w / 9));
    const room = Math.max(1, Math.floor((box.h - headH) / rowH + 0.05));
    const shown = v.people.length <= room ? v.people : v.people.slice(0, room - 1);
    const more = v.people.length - shown.length;
    const num = { size: Math.round(rowH * 0.8), family: fonts.sans };
    const lab = { size: Math.round(headH * 0.36), family: fonts.sans };
    // Green when you are on pace, red when not; neutral while nothing is due.
    const vsPace = (got: number, due: number | undefined, base: string) => (due === undefined || due <= 0 ? base : got >= due ? colors.ok : colors.alert);
    const trend = { up: ['↑', colors.info], steady: ['→', colors.inkDim], down: ['↓', colors.warn] } as const;
    const rows = shown.map((p) => ({
      p,
      name: p.me ? tr({ en: 'you', es: 'tú' }) : shortName(p.user, options.aliases),
      cells: [
        [hoursText(p.today, locale), vsPace(p.today, p.me ? pace.today : undefined, p.today > 0 ? colors.ink : colors.inkDim)],
        [hoursRound(p.week), vsPace(p.week, p.me ? pace.week : undefined, colors.ink)],
        [p.dayAvg === null ? '—' : hoursText(p.dayAvg, locale), colors.inkDim],
        [p.weekAvg === null ? '—' : hoursRound(p.weekAvg), colors.inkDim],
        p.trend ? trend[p.trend] : ['', colors.inkDim],
      ] as [string, string][],
    }));
    const colW = labels.map((l, i) => Math.max(kit.measureTracked(g, l, lab), ...rows.map((r) => kit.measureTracked(g, r.cells[i]![0], num))));
    const longest = Math.max(...rows.map((r) => kit.measureTracked(g, r.name, num)));
    const free = box.w - colW.reduce((a, b) => a + b, 0);
    const nameW = Math.min(longest, free - rowH * 0.3 * colW.length);
    const air = Math.max(0, (free - nameW) / colW.length);
    const rights: number[] = [];
    let r = box.x + nameW;
    colW.forEach((cw, i) => (rights[i] = r += air + cw));
    // Header: what is due by now on the left, column labels on the right.
    kit.drawTracked(g, `${tr(TEXT.due)} ${hoursText(pace.today, locale)} · ${hoursRound(pace.week)}`, box.x, box.y + lab.size * 1.05, { ...lab, color: colors.inkDim });
    labels.forEach((l, i) => kit.drawTracked(g, l, rights[i]!, box.y + headH * 0.85, { ...lab, color: colors.inkFaint, align: 'right' }));
    rows.forEach(({ p, name, cells }, k) => {
      const base = box.y + headH + k * rowH + rowH * 0.82;
      kit.drawTracked(g, kit.truncate(g, name, nameW, num), box.x, base, { ...num, color: p.me ? colors.accent : colors.ink });
      cells.forEach(([text, color], i) => kit.drawTracked(g, text, rights[i]!, base, { ...num, color, align: 'right' }));
    });
    if (more) kit.drawTracked(g, `+${more} ${tr(TEXT.more)}`, box.x, box.y + headH + shown.length * rowH + rowH * 0.7, { ...lab, color: colors.inkDim });
  },
  demo: ({ now }) => ({ sources: { [TIMELOGS]: demoTimelogs(now) } }),
});

/** Today's meetings from the calendar source (it may carry the next days too). */
export function meetingsToday(v: unknown, now: number): MeetingLike[] {
  if (!Array.isArray(v)) return [];
  const day = dayKey(now);
  return (v as MeetingLike[]).filter((m) => dayKey(m.startsAt) === day);
}

const focusOf = (sources: Record<string, unknown>, now: number, w: Workday, minPendingMin: number) => {
  const tl = timelogsOf(sources);
  if (!tl) return null;
  const act = sources[ACTIVITY] as ActivityData | undefined;
  const day = dayKey(now);
  return focusView({
    now,
    meetings: meetingsToday(sources[CALENDAR], now),
    logged: tl.today.day === day ? tl.today.entries : [],
    activity: act?.day === day ? act.projects : [],
    expected: expectedHours(now, w).today,
    minPendingMin,
  });
};

export const focus = defineWidget({
  id: 'focus',
  name: { en: 'Left to log', es: 'Por imputar' },
  description: {
    en: 'What you have logged today against what is due by now, and what is still unlogged: finished meetings and agent activity per project.',
    es: 'Lo imputado hoy frente a lo que toca a esta hora, y lo que falta por imputar: reuniones terminadas y actividad con agentes por proyecto.',
  },
  icon: 'list-checks',
  category: 'dev',
  tags: ['gitlab', 'timesheet', 'imputación', 'focus'],
  size: { min: { w: 300, h: 160 }, preferred: { w: 600, h: 420 } },
  sources: [TIMELOGS, ACTIVITY, CALENDAR],
  options: t.object({
    ...workdayFields(),
    minPendingMin: t.integer({ default: 15, min: 0, max: 240, unit: 'min', label: { en: 'Smallest activity to propose', es: 'Actividad mínima a proponer' } }),
    meetingGraceMin: t.integer({ default: 15, min: 0, max: 240, unit: 'min', advanced: true, label: { en: 'Urgent after a meeting for', es: 'Urgente tras una reunión durante' } }),
    closingMin: t.integer({ default: 30, min: 0, max: 240, unit: 'min', advanced: true, label: { en: 'Urgent before leaving', es: 'Urgente antes de salir' }, help: { en: 'In the last minutes of the day, if hours are still owed.', es: 'En los últimos minutos de la jornada, si aún se deben horas.' } }),
  }),
  redraw: 'minute',
  visible: ({ options, sources, now }) => {
    const v = focusOf(sources, now, workdayOf(options), options.minPendingMin);
    return Boolean(v) && (inWorkday(now, workdayOf(options)) || v!.meetings.length > 0 || v!.projects.length > 0);
  },
  urgent: ({ options, sources, now }) => {
    const w = workdayOf(options);
    const v = focusOf(sources, now, w, options.minPendingMin);
    if (!v) return false;
    if (v.meetings.some((m) => now - m.endsAt <= options.meetingGraceMin * 60_000)) return true;
    const left = minutesToEnd(now, w);
    return left !== null && left <= options.closingMin && (v.expected - v.logged >= 0.25 || v.meetings.length > 0);
  },
  render(g, { options, sources, now, box, theme, kit, t: tr, locale }) {
    const v = focusOf(sources, now, workdayOf(options), options.minPendingMin);
    if (!v) return;
    const { colors, fonts } = theme;
    const f = fonts.sans;
    const k = Math.max(0.45, Math.min(1.6, box.w / 600, box.h / 420));
    const debt = Math.max(0, v.expected - v.logged);
    const color = debt >= 2 ? colors.alert : debt >= 1 ? colors.warn : colors.ok;
    const h = (n: number) => `${hoursText(n, locale)} h`;
    // Top: logged, big, in the colour of what is owed; on the right, what is due.
    const lw = kit.drawTracked(g, h(v.logged), box.x, box.y + 58 * k, { size: 64 * k, family: f, color });
    if (box.w - lw > 330 * k) kit.drawTracked(g, tr(TEXT.loggedToday), box.x + lw + 16 * k, box.y + 56 * k, { size: 26 * k, family: f, color: colors.inkDim });
    kit.drawTracked(g, `${tr(TEXT.due)} ${h(v.expected)}`, box.x + box.w, box.y + 28 * k, { size: 28 * k, family: f, color: colors.inkDim, align: 'right' });
    if (debt >= 0.1) kit.drawTracked(g, `${tr(TEXT.left)} ${h(debt)}`, box.x + box.w, box.y + 60 * k, { size: 30 * k, family: f, color, align: 'right' });
    const rows: [string, string, string][] = [
      ...v.meetings.map((m): [string, string, string] => [m.private ? tr(TEXT.privateMeeting) : m.title, minutesText(Math.round((m.endsAt - m.startsAt) / 60_000)), colors.warn]),
      ...v.projects.map((p): [string, string, string] => [p.project, `${minutesText(p.pending)} ${tr(TEXT.unlogged)}`, colors.info]),
    ];
    let y = box.y + 92 * k;
    if (!rows.length) {
      kit.drawTracked(g, kit.truncate(g, tr(TEXT.nothing), box.w, { size: 34 * k, family: f }), box.x, y + 40 * k, { size: 34 * k, family: f, color: colors.ok });
      return;
    }
    kit.drawTracked(g, tr(TEXT.notLogged), box.x, y + 24 * k, { size: 22 * k, family: f, color: colors.inkDim });
    y += 30 * k;
    const rowH = 46 * k;
    const all = Math.floor((box.y + box.h - y) / rowH);
    const room = rows.length > all ? Math.max(0, Math.floor((box.y + box.h - 30 * k - y) / rowH)) : all;
    rows.slice(0, room).forEach(([name, what, col], i) => {
      const ry = y + i * rowH + 36 * k;
      g.fillStyle = col;
      g.beginPath();
      g.arc(box.x + 8 * k, ry - 11 * k, 7 * k, 0, Math.PI * 2);
      g.fill();
      const ww = kit.drawTracked(g, what, box.x + box.w, ry, { size: 28 * k, family: f, color: colors.inkDim, align: 'right' });
      kit.drawTracked(g, kit.truncate(g, name, box.w - ww - 44 * k, { size: 34 * k, family: f }), box.x + 26 * k, ry, { size: 34 * k, family: f, color: colors.ink });
    });
    if (rows.length > room) kit.drawTracked(g, `+${rows.length - room} ${tr(TEXT.more)}`, box.x + 26 * k, box.y + box.h - 4 * k, { size: 24 * k, family: f, color: colors.inkDim });
  },
  demo: ({ now }) => ({ sources: { [TIMELOGS]: demoTimelogs(now), [ACTIVITY]: demoActivity(now), [CALENDAR]: demoMeetings(now) } }),
});

export default definePlugin({
  id: 'timesheet',
  name: { en: 'Timesheet', es: 'Imputación de horas' },
  version: '0.1.0',
  description: { en: 'Hours logged in GitLab, yours and your group\'s, and what is still left to log today.', es: 'Las horas imputadas en GitLab, tuyas y de tu grupo, y lo que falta por imputar hoy.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'clock',
  widgets: [hours, focus],
  sources: [timelogs, activity],
});
