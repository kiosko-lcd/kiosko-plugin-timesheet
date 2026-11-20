/**
 * Timesheet: the hours logged in GitLab (yours and your group's, today, this
 * week and on average) and, for today, what is still left to log: finished
 * meetings from `calendar/events` and agent activity per project.
 */
import { defineSource, definePlugin, defineWidget, drawEmpty, drawMore, listLayout, listOptions, matchFilter, t, type Localized, type Workday } from '@kiosko/sdk';
import { activityByProject, dayKey, DEFAULT_ACTIVITY_DIR, readActivity, type ProjectActivity } from './activity.ts';
import { demoActivity, demoMeetings, demoTimelogs } from './demo.ts';
import { fetchMyTimelogs, focusView, TEXT, type LoggedEntry, type MeetingLike } from './focus.ts';
import { connect, whoAmI } from './gitlab.ts';
import { addDays, expectedHours, fetchRows, hoursRound, hoursText, inWorkday, localDay, minutesToEnd, shortName, summarize, type PersonHours, type TimelogRow } from './timesheet.ts';

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
  name: { en: 'GitLab timelogs', es: 'Imputaciones de GitLab', 'zh-Hant': 'GitLab 工時紀錄', 'zh-Hans': 'GitLab 工时记录' },
  description: {
    en: 'Hours logged in GitLab by you and your group over the last weeks, and your own entries of today, through glab or a token.',
    es: 'Las horas imputadas en GitLab por ti y tu grupo en las últimas semanas, y tus imputaciones de hoy, con glab o con un token.',
    'zh-Hant': '你和你的群組最近幾週在 GitLab 登記的工時，以及你今天的登記項目，透過 glab 或權杖取得。',
    'zh-Hans': '你和你的群组最近几周在 GitLab 登记的工时，以及你今天的登记条目，通过 glab 或令牌获取。',
  },
  options: t.object({
    host: t.string({ placeholder: 'gitlab.com', risk: 'network', label: { en: 'GitLab host', es: 'Servidor de GitLab', 'zh-Hant': 'GitLab 主機', 'zh-Hans': 'GitLab 主机' }, help: { en: 'Empty = glab\'s default host (gitlab.com with a token).', es: 'Vacío = el servidor por defecto de glab (gitlab.com con token).', 'zh-Hant': '留空 = glab 的預設主機（使用權杖時為 gitlab.com）。', 'zh-Hans': '留空 = glab 的默认主机（使用令牌时为 gitlab.com）。' } }),
    token: t.string({ secret: true, label: { en: 'Access token', es: 'Token de acceso', 'zh-Hant': '存取權杖', 'zh-Hans': '访问令牌' }, help: { en: 'A personal access token with read_api. Empty = use the glab CLI and its login.', es: 'Un token personal con read_api. Vacío = usar el CLI glab y su sesión.', 'zh-Hant': '具 read_api 權限的個人存取權杖。留空 = 使用 glab CLI 及其登入狀態。', 'zh-Hans': '具有 read_api 权限的个人访问令牌。留空 = 使用 glab CLI 及其登录状态。' } }),
    group: t.string({ placeholder: 'acme/team', label: { en: 'Group', es: 'Grupo', 'zh-Hant': '群組', 'zh-Hans': '群组' }, help: { en: 'Full path of the GitLab group whose hours to show. Empty = only yours.', es: 'Ruta completa del grupo de GitLab cuyas horas mostrar. Vacío = sólo las tuyas.', 'zh-Hant': '要顯示工時的 GitLab 群組完整路徑。留空 = 只顯示你的。', 'zh-Hans': '要显示工时的 GitLab 群组完整路径。留空 = 只显示你的。' } }),
    me: t.string({ advanced: true, label: { en: 'Your username', es: 'Tu usuario', 'zh-Hant': '你的使用者名稱', 'zh-Hans': '你的用户名' }, help: { en: 'Empty = the logged-in user.', es: 'Vacío = el usuario con sesión iniciada.', 'zh-Hant': '留空 = 目前登入的使用者。', 'zh-Hans': '留空 = 当前登录的用户。' } }),
    weeks: t.integer({ default: 4, min: 1, max: 12, label: { en: 'Weeks for the averages', es: 'Semanas para las medias', 'zh-Hant': '計算平均的週數', 'zh-Hans': '计算平均值的周数' } }),
    bin: t.string({ default: 'glab', format: 'path', risk: 'exec', advanced: true, label: { en: 'glab command', es: 'Comando glab', 'zh-Hant': 'glab 指令', 'zh-Hans': 'glab 命令' } }),
  }),
  intervalMs: 5 * 60_000,
  // Up to 30 pages of timelogs for a big group: not more than once a minute.
  minIntervalMs: 60_000,
  timeoutMs: 60_000,
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
  name: { en: 'Agent activity', es: 'Actividad de agentes', 'zh-Hant': '代理活動', 'zh-Hans': '智能体活动' },
  description: {
    en: 'Today\'s work blocks per project, from the agent hook\'s activity log (one JSONL file per day).',
    es: 'Los bloques de trabajo de hoy por proyecto, del registro de actividad del hook de agentes (un JSONL por día).',
    'zh-Hant': '今天各專案的工作區塊，取自代理 hook 的活動紀錄（每天一個 JSONL 檔案）。',
    'zh-Hans': '今天各项目的工作区块，取自智能体 hook 的活动日志（每天一个 JSONL 文件）。',
  },
  options: t.object({
    dir: t.string({ default: DEFAULT_ACTIVITY_DIR, format: 'path', risk: 'path', label: { en: 'Activity folder', es: 'Carpeta de actividad', 'zh-Hant': '活動資料夾', 'zh-Hans': '活动文件夹' } }),
    gapMs: t.duration({ default: 15 * 60_000, min: 60_000, max: 2 * 3_600_000, advanced: true, label: { en: 'Gap that splits a block', es: 'Hueco que parte un bloque', 'zh-Hant': '分割區塊的間隔', 'zh-Hans': '拆分区块的间隔' } }),
    tailMs: t.duration({ default: 5 * 60_000, min: 0, max: 3_600_000, advanced: true, label: { en: 'Time added after the last event', es: 'Tiempo tras el último evento', 'zh-Hant': '最後一個事件後追加的時間', 'zh-Hans': '最后一个事件后追加的时间' } }),
  }),
  intervalMs: 2 * 60_000,
  // A local file that grows all day: re-reading it every few seconds buys nothing.
  minIntervalMs: 15_000,
  async read({ options: o, now }): Promise<ActivityData> {
    const day = dayKey(now);
    return { day, projects: activityByProject(await readActivity(day, o.dir), o.gapMs, o.tailMs) };
  },
  demo: ({ now }) => demoActivity(now),
});

const timelogsOf = (s: Record<string, unknown>) => s[TIMELOGS] as TimelogsData | undefined;

type Column = 'today' | 'week' | 'dayAvg' | 'weekAvg' | 'trend';
const COLUMNS: Column[] = ['today', 'week', 'dayAvg', 'weekAvg', 'trend'];
const COLUMN_NAMES: Record<Column, Localized> = {
  today: { en: 'Today', es: 'Hoy', 'zh-Hant': '今天', 'zh-Hans': '今天' },
  week: { en: 'This week', es: 'Esta semana', 'zh-Hant': '本週', 'zh-Hans': '本周' },
  dayAvg: { en: 'Daily average', es: 'Media diaria', 'zh-Hant': '每日平均', 'zh-Hans': '日均' },
  weekAvg: { en: 'Weekly average', es: 'Media semanal', 'zh-Hant': '每週平均', 'zh-Hans': '周均' },
  trend: { en: 'Trend', es: 'Tendencia', 'zh-Hant': '趨勢', 'zh-Hans': '趋势' },
};
/** Column headers: short, four columns have to fit. */
const COLUMN_HEADS: Record<Column, Localized> = {
  today: { en: 'today', es: 'hoy', 'zh-Hant': '今日', 'zh-Hans': '今日' },
  week: { en: 'wk', es: 'sem', 'zh-Hant': '本週', 'zh-Hans': '本周' },
  dayAvg: { en: 'h/day', es: 'h/día', 'zh-Hant': 'h/日', 'zh-Hans': 'h/日' },
  weekAvg: { en: 'h/wk', es: 'h/sem', 'zh-Hant': 'h/週', 'zh-Hans': 'h/周' },
  trend: { en: '', es: '', 'zh-Hant': '', 'zh-Hans': '' },
};

/** The columns to draw, in the user's order, each once; empty = all. */
export const columnsOf = (cols: readonly string[]): Column[] => {
  const picked = [...new Set(cols)].filter((c): c is Column => (COLUMNS as string[]).includes(c));
  return picked.length ? picked : COLUMNS;
};

type HoursOptions = { people: string[]; aliases: Record<string, string> };

/**
 * The summary of a source's data, kept while the data and the minute stay the
 * same: the widget asks for it in `empty` and in `render`, every minute, and
 * the figures only change with new timelogs or a new minute.
 */
const summaries = new WeakMap<TimelogsData, { key: string; view: ReturnType<typeof summarize> }>();
function summaryOf(data: TimelogsData, now: number, workday: Workday) {
  const key = `${Math.floor(now / 60_000)}|${JSON.stringify(workday)}`;
  const hit = summaries.get(data);
  if (hit?.key === key) return hit.view;
  const view = summarize(data.rows, { now, me: data.me, weeks: data.weeks, workday });
  summaries.set(data, { key, view });
  return view;
}

/** The people of the table: everyone in the timelogs, through the `people` filter (by username or by alias). */
export function peopleOf(data: TimelogsData, o: HoursOptions, now: number, workday: Workday): PersonHours[] {
  const v = summaryOf(data, now, workday);
  return v.people.filter((p) => {
    const alias = o.aliases[p.user];
    return matchFilter(alias ? [p.user, alias] : p.user, o.people);
  });
}

export const hours = defineWidget({
  id: 'hours',
  name: { en: 'Hours logged', es: 'Horas imputadas', 'zh-Hant': '已登記工時', 'zh-Hans': '已登记工时' },
  description: {
    en: 'Hours logged in GitLab by you and your group: today, this week, daily and weekly averages, and each one\'s trend against themselves. Yours turn green or red against what is due by now, per your working week in Settings.',
    es: 'Las horas imputadas en GitLab por ti y tu grupo: hoy, la semana, medias diaria y semanal, y la tendencia de cada cual contra sí mismo. Las tuyas, en verde o rojo según lo que toca a esta hora, según tu jornada de Ajustes.',
    'zh-Hant': '你和你的群組在 GitLab 登記的工時：今天、本週、每日與每週平均，以及每項相對於自身的趨勢。你的數字會依「設定」中的工作週，與目前應登記的時數比較，顯示為綠色或紅色。',
    'zh-Hans': '你和你的群组在 GitLab 登记的工时：今天、本周、日均和周均，以及每项相对自身的趋势。你的数字会根据“设置”中的工作周，与当前应登记的时数比较，显示为绿色或红色。',
  },
  icon: 'clock',
  category: 'dev',
  tags: ['gitlab', 'timesheet', 'horas', 'imputación'],
  size: { min: { w: 280, h: 120 }, preferred: { w: 600, h: 300 } },
  sources: [TIMELOGS],
  options: t.object({
    ...listOptions(),
    columns: t.list(t.enum(COLUMNS, { default: 'today', labels: COLUMN_NAMES }), {
      default: [...COLUMNS],
      max: COLUMNS.length,
      label: { en: 'Columns', es: 'Columnas', 'zh-Hant': '欄位', 'zh-Hans': '列' },
      help: { en: 'Which figures, in this order. Empty = all.', es: 'Qué cifras, en este orden. Vacío = todas.', 'zh-Hant': '要顯示哪些數字及其順序。留空 = 全部。', 'zh-Hans': '要显示哪些数字及其顺序。留空 = 全部。' },
    }),
    people: t.filter({ label: { en: 'People', es: 'Personas', 'zh-Hant': '成員', 'zh-Hans': '成员' }, help: { en: 'Empty: the whole group. Usernames or patterns, comma-separated (ana.*, !bot-*); an alias works too.', es: 'Vacío: todo el grupo. Usuarios o patrones separados por comas (ana.*, !bot-*); también vale el alias.', 'zh-Hant': '留空：整個群組。以逗號分隔的使用者名稱或模式（ana.*, !bot-*）；也可使用別名。', 'zh-Hans': '留空：整个群组。以逗号分隔的用户名或模式（ana.*, !bot-*）；也可使用别名。' } }),
    aliases: t.map({ advanced: true, label: { en: 'Names', es: 'Nombres', 'zh-Hant': '顯示名稱', 'zh-Hans': '显示名称' }, help: { en: 'Username → what to show. Others show their first three letters.', es: 'Usuario → lo que se muestra. El resto, sus tres primeras letras.', 'zh-Hant': '使用者名稱 → 要顯示的文字。其他人顯示前三個字母。', 'zh-Hans': '用户名 → 要显示的文字。其他人显示前三个字母。' }, keyLabel: { en: 'Username', es: 'Usuario', 'zh-Hant': '使用者名稱', 'zh-Hans': '用户名' }, valueLabel: { en: 'Show as', es: 'Mostrar como', 'zh-Hant': '顯示為', 'zh-Hans': '显示为' } }),
  }),
  redraw: 'minute',
  visible: ({ sources }) => Boolean(timelogsOf(sources)),
  empty: ({ options, sources, now, workday }) => {
    const data = timelogsOf(sources);
    return Boolean(data) && !peopleOf(data!, options, now, workday).length;
  },
  render(g, ctx) {
    const { options, sources, now, box, theme, kit, t: tr, locale, workday } = ctx;
    const data = timelogsOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const people = peopleOf(data, options, now, workday);
    if (!people.length) return drawEmpty(g, ctx, tr({ en: 'Nobody to show', es: 'Nadie que mostrar', 'zh-Hant': '沒有可顯示的人', 'zh-Hans': '没有可显示的人' }));
    const pace = expectedHours(now, workday);
    const cols = columnsOf(options.columns);
    const headH = Math.min(64, box.h * 0.22);
    const plan = listLayout({ ...box, y: box.y + headH, h: box.h - headH }, people.length, options, { sizes: { 'one-line': { min: 22, max: Math.max(22, Math.min(64, box.w / 9)) } }, minRows: 2 });
    const { rowH } = plan;
    const num = { size: Math.round(rowH * 0.8), family: fonts.sans };
    const lab = { size: Math.max(9, Math.round(headH * 0.36)), family: fonts.sans };
    // Green when you are on pace, red when not; neutral while nothing is due.
    const vsPace = (got: number, due: number | undefined, base: string) => (due === undefined || due <= 0 ? base : got >= due ? colors.ok : colors.alert);
    const trend = { up: ['↑', colors.info], steady: ['→', colors.inkDim], down: ['↓', colors.warn] } as const;
    const cell = (p: PersonHours, c: Column): [string, string] => {
      switch (c) {
        case 'today': return [hoursText(p.today, locale), vsPace(p.today, p.me ? pace.today : undefined, p.today > 0 ? colors.ink : colors.inkDim)];
        case 'week': return [hoursRound(p.week), vsPace(p.week, p.me ? pace.week : undefined, colors.ink)];
        case 'dayAvg': return [p.dayAvg === null ? '—' : hoursText(p.dayAvg, locale), colors.inkDim];
        case 'weekAvg': return [p.weekAvg === null ? '—' : hoursRound(p.weekAvg), colors.inkDim];
        case 'trend': return p.trend ? [...trend[p.trend]] : ['', colors.inkDim];
      }
    };
    const rows = people.slice(0, plan.shown).map((p) => ({ p, name: p.me ? tr({ en: 'you', es: 'tú', 'zh-Hant': '你', 'zh-Hans': '你' }) : shortName(p.user, options.aliases), cells: cols.map((c) => cell(p, c)) }));
    const labels = cols.map((c) => tr(COLUMN_HEADS[c]));
    const colW = labels.map((l, i) => Math.max(kit.measureTracked(g, l, lab), ...rows.map((r) => kit.measureTracked(g, r.cells[i]![0], num))));
    // Names start a little in (the tail of a j would leave the box): their column counts it.
    const inset = Math.ceil(num.size * 0.08);
    const longest = Math.max(0, ...rows.map((r) => kit.measureTracked(g, r.name, num))) + inset;
    const free = box.w - colW.reduce((a, b) => a + b, 0);
    const nameW = Math.min(longest, free - rowH * 0.3 * colW.length);
    const air = Math.max(0, (free - nameW) / Math.max(1, colW.length));
    const rights: number[] = [];
    let r = box.x + nameW;
    colW.forEach((cw, i) => (rights[i] = r += air + cw));
    // Header: what is due by now on the left, column labels on the right.
    kit.drawTracked(g, `${tr(TEXT.due)} ${hoursText(pace.today, locale)} · ${hoursRound(pace.week)}`, box.x, box.y + lab.size * 1.05, { ...lab, color: colors.inkDim });
    labels.forEach((l, i) => kit.drawTracked(g, l, rights[i]!, box.y + headH * 0.85, { ...lab, color: colors.inkFaint, align: 'right' }));
    rows.forEach(({ p, name, cells }, k) => {
      const row = plan.rows[k]!;
      const base = row.y + rowH * 0.82;
      kit.drawTracked(g, kit.truncate(g, name, nameW - inset, num), box.x + inset, base, { ...num, color: p.me ? colors.accent : colors.ink });
      cells.forEach(([text, color], i) => kit.drawTracked(g, text, rights[i]!, base, { ...num, color, align: 'right' }));
    });
    drawMore(g, ctx, plan);
  },
  demo: ({ now }) => ({ sources: { [TIMELOGS]: demoTimelogs(now) } }),
});

/** Today's meetings from the calendar source (it may carry the next days too). */
export function meetingsToday(v: unknown, now: number): MeetingLike[] {
  if (!Array.isArray(v)) return [];
  const day = dayKey(now);
  return (v as MeetingLike[]).filter((m) => dayKey(m.startsAt) === day);
}

const focusOf = (sources: Record<string, unknown>, now: number, w: Workday, minPendingMs: number) => {
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
    minPendingMs,
  });
};

const HOUR = 3_600_000;
const MIN = 60_000;

export const focus = defineWidget({
  id: 'focus',
  name: { en: 'Left to log', es: 'Por imputar', 'zh-Hant': '待登記', 'zh-Hans': '待登记' },
  description: {
    en: 'What you have logged today against what is due by now (per your working week in Settings), and what is still unlogged: finished meetings and agent activity per project.',
    es: 'Lo imputado hoy frente a lo que toca a esta hora (según tu jornada de Ajustes), y lo que falta por imputar: reuniones terminadas y actividad con agentes por proyecto.',
    'zh-Hant': '你今天已登記的工時與目前應登記的時數比較（依「設定」中的工作週），以及仍未登記的項目：已結束的會議與各專案的代理活動。',
    'zh-Hans': '你今天已登记的工时与当前应登记的时数对比（根据“设置”中的工作周），以及尚未登记的内容：已结束的会议和各项目的智能体活动。',
  },
  icon: 'list-checks',
  category: 'dev',
  tags: ['gitlab', 'timesheet', 'imputación', 'focus'],
  size: { min: { w: 300, h: 160 }, preferred: { w: 600, h: 420 } },
  sources: [TIMELOGS, ACTIVITY, CALENDAR],
  options: t.object({
    ...listOptions(),
    minPendingMs: t.duration({ default: 15 * MIN, min: 0, max: 4 * HOUR, label: { en: 'Smallest activity to propose', es: 'Actividad mínima a proponer', 'zh-Hant': '建議登記的最短活動', 'zh-Hans': '建议登记的最短活动' } }),
    debtWarnMs: t.duration({ default: HOUR, min: 0, max: 8 * HOUR, advanced: true, label: { en: 'Owed: amber from', es: 'Debes: ámbar desde', 'zh-Hant': '欠登：琥珀色門檻', 'zh-Hans': '欠登：琥珀色阈值' }, help: { en: 'Hours due by now and not logged yet.', es: 'Horas que tocan a esta hora y aún no están imputadas.', 'zh-Hant': '目前應登記但尚未登記的時數。', 'zh-Hans': '当前应登记但尚未登记的时数。' } }),
    debtAlertMs: t.duration({ default: 2 * HOUR, min: 0, max: 8 * HOUR, advanced: true, label: { en: 'Owed: red from', es: 'Debes: rojo desde', 'zh-Hant': '欠登：紅色門檻', 'zh-Hans': '欠登：红色阈值' } }),
    meetingGraceMs: t.duration({ default: 15 * MIN, min: 0, max: 4 * HOUR, advanced: true, label: { en: 'Urgent after a meeting for', es: 'Urgente tras una reunión durante', 'zh-Hant': '會議結束後多久轉為緊急', 'zh-Hans': '会议结束后多久转为紧急' }, help: { en: '0 = never.', es: '0 = nunca.', 'zh-Hant': '0 = 永不。', 'zh-Hans': '0 = 从不。' } }),
    closingMs: t.duration({ default: 30 * MIN, min: 0, max: 4 * HOUR, advanced: true, label: { en: 'Urgent before leaving', es: 'Urgente antes de salir', 'zh-Hant': '下班前轉為緊急', 'zh-Hans': '下班前转为紧急' }, help: { en: 'In the last minutes of the day, if hours are still owed. 0 = never.', es: 'En los últimos minutos de la jornada, si aún se deben horas. 0 = nunca.', 'zh-Hant': '一天的最後幾分鐘內，若仍有工時未登記。0 = 永不。', 'zh-Hans': '一天的最后几分钟内，若仍有工时未登记。0 = 从不。' } }),
  }),
  redraw: 'minute',
  visible: ({ options, sources, now, workday }) => {
    const v = focusOf(sources, now, workday, options.minPendingMs);
    return Boolean(v) && (inWorkday(now, workday) || v!.meetings.length > 0 || v!.projects.length > 0);
  },
  urgent: ({ options, sources, now, workday }) => {
    const v = focusOf(sources, now, workday, options.minPendingMs);
    if (!v) return false;
    if (options.meetingGraceMs > 0 && v.meetings.some((m) => now - m.endsAt <= options.meetingGraceMs)) return true;
    const left = minutesToEnd(now, workday);
    return options.closingMs > 0 && left !== null && left * MIN <= options.closingMs && (v.expected - v.logged >= 0.25 || v.meetings.length > 0);
  },
  render(g, ctx) {
    const { options, sources, now, box, theme, kit, fmt, t: tr, locale, workday } = ctx;
    const v = focusOf(sources, now, workday, options.minPendingMs);
    if (!v) return;
    const { colors, fonts } = theme;
    const f = fonts.sans;
    const k = Math.max(0.45, Math.min(1.6, box.w / 600, box.h / 420));
    const debt = Math.max(0, v.expected - v.logged) * HOUR;
    const color = debt >= options.debtAlertMs && options.debtAlertMs > 0 ? colors.alert : debt >= options.debtWarnMs && options.debtWarnMs > 0 ? colors.warn : colors.ok;
    const h = (n: number) => `${hoursText(n, locale)} h`;
    // Top: logged, big, in the colour of what is owed; on the right, what is due.
    const lw = kit.drawTracked(g, h(v.logged), box.x, box.y + 58 * k, { size: 64 * k, family: f, color });
    if (box.w - lw > 330 * k) kit.drawTracked(g, tr(TEXT.loggedToday), box.x + lw + 16 * k, box.y + 56 * k, { size: 26 * k, family: f, color: colors.inkDim });
    kit.drawTracked(g, `${tr(TEXT.due)} ${h(v.expected)}`, box.x + box.w, box.y + 28 * k, { size: 28 * k, family: f, color: colors.inkDim, align: 'right' });
    if (debt >= 0.1 * HOUR) kit.drawTracked(g, `${tr(TEXT.left)} ${h(debt / HOUR)}`, box.x + box.w, box.y + 60 * k, { size: 30 * k, family: f, color, align: 'right' });
    const rows: [string, string, string][] = [
      ...v.meetings.map((m): [string, string, string] => [m.private ? tr(TEXT.privateMeeting) : m.title, fmt.duration(m.endsAt - m.startsAt, { round: 'nearest', compact: true }), colors.warn]),
      ...v.projects.map((p): [string, string, string] => [p.project, `${fmt.duration(p.pending * MIN)} ${tr(TEXT.unlogged)}`, colors.info]),
    ];
    let y = box.y + 92 * k;
    if (!rows.length) {
      kit.drawTracked(g, kit.truncate(g, tr(TEXT.nothing), box.w, { size: 34 * k, family: f }), box.x, y + 40 * k, { size: 34 * k, family: f, color: colors.ok });
      return;
    }
    kit.drawTracked(g, tr(TEXT.notLogged), box.x, y + 24 * k, { size: 22 * k, family: f, color: colors.inkDim });
    y += 30 * k;
    const plan = listLayout({ ...box, y, h: box.y + box.h - y }, rows.length, options, { sizes: { 'one-line': { min: Math.max(18, 30 * k), max: 46 * k } } });
    const u = plan.rowH / 46;
    plan.rows.forEach((row, i) => {
      const [name, what, col] = rows[i]!;
      const ry = row.y + 36 * u;
      g.fillStyle = col;
      g.beginPath();
      g.arc(box.x + 8 * u, ry - 11 * u, 7 * u, 0, Math.PI * 2);
      g.fill();
      const ww = kit.drawTracked(g, what, box.x + box.w, ry, { size: 28 * u, family: f, color: colors.inkDim, align: 'right' });
      kit.drawTracked(g, kit.truncate(g, name, box.w - ww - 44 * u, { size: 34 * u, family: f }), box.x + 26 * u, ry, { size: 34 * u, family: f, color: colors.ink });
    });
    drawMore(g, ctx, plan, { indent: 26 * u });
  },
  demo: ({ now }) => ({ sources: { [TIMELOGS]: demoTimelogs(now), [ACTIVITY]: demoActivity(now), [CALENDAR]: demoMeetings(now) } }),
});

export default definePlugin({
  id: 'timesheet',
  name: { en: 'Timesheet', es: 'Imputación de horas', 'zh-Hant': '工時', 'zh-Hans': '工时' },
  version: '0.2.2',
  languages: ['en', 'es', 'zh-Hant', 'zh-Hans'],
  sdk: '^0.2.0',
  permissions: { network: ['gitlab.com', 'user'], exec: ['glab'], files: ['~/.aimonitor/actividad'] },
  optional: ['calendar/events'],
  description: { en: 'Hours logged in GitLab, yours and your group\'s, and what is still left to log today.', es: 'Las horas imputadas en GitLab, tuyas y de tu grupo, y lo que falta por imputar hoy.', 'zh-Hant': '你和你群組在 GitLab 已登記的工時，以及今天還有哪些待登記。', 'zh-Hans': '你和你群组在 GitLab 已登记的工时，以及今天还有哪些待登记。' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'clock',
  widgets: [hours, focus],
  sources: [timelogs, activity],
});
