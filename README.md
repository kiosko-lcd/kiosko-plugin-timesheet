# kiosko-plugin-timesheet

Hours logged in GitLab, yours and your group's, and what is still left to log today.

A plugin for [Kiosko](https://github.com/kiosko-lcd/kiosko), the widget mosaic for small USB LCD panels.

![Hours logged](docs/hours.png)

## Install

In Kiosko, **Plugins → Install from npm** → `kiosko-plugin-timesheet`, then restart Kiosko. Or from a terminal:

```sh
npm install --prefix ~/.config/kiosko/plugins kiosko-plugin-timesheet
```

(macOS: `~/Library/Application Support/Kiosko/plugins`, Windows: `%APPDATA%\Kiosko\plugins`.)

## Requirements

- [`glab`](https://gitlab.com/gitlab-org/cli) logged in, or a personal access token with `read_api` in the `timesheet/timelogs` source options.
- For *Left to log*: the `calendar/events` source from [kiosko-plugin-calendar](../kiosko-plugin-calendar) for meetings, and the activity log the aimonitor agent hook writes to `~/.aimonitor/actividad` for agent work.

## Widgets

### Hours logged — `timesheet/hours`

Hours logged in GitLab by you and your group: today, this week, daily and weekly averages, and each one's trend against themselves. Yours turn green or red against what is due by now.

![Hours logged](docs/hours.png)

Uses: `timesheet/timelogs`.

| Option | Type | Default | |
|---|---|---|---|
| `start` | string | `"09:00"` | Workday starts |
| `end` | string | `"17:00"` | Workday ends |
| `hours` | number | `8` | Hours per day |
| `weekly` | number | `40` | Hours per week |
| `fridayEnd` | string | `""` | Friday ends. Empty = like any other day. |
| `fridayHours` | number | `0` | Friday hours |
| `holidays` | list | `[]` | Holidays |
| `aliases` | map | `{}` | Names. Username → what to show. Others show their first three letters. |

### Left to log — `timesheet/focus`

What you have logged today against what is due by now, and what is still unlogged: finished meetings and agent activity per project.

![Left to log](docs/focus.png)

Uses: `timesheet/timelogs`, `timesheet/activity`, `calendar/events`.

| Option | Type | Default | |
|---|---|---|---|
| `start` | string | `"09:00"` | Workday starts |
| `end` | string | `"17:00"` | Workday ends |
| `hours` | number | `8` | Hours per day |
| `weekly` | number | `40` | Hours per week |
| `fridayEnd` | string | `""` | Friday ends. Empty = like any other day. |
| `fridayHours` | number | `0` | Friday hours |
| `holidays` | list | `[]` | Holidays |
| `minPendingMin` | number | `15` | Smallest activity to propose |
| `meetingGraceMin` | number | `15` | Urgent after a meeting for |
| `closingMin` | number | `30` | Urgent before leaving. In the last minutes of the day, if hours are still owed. |

## Data sources

### GitLab timelogs — `timesheet/timelogs`

Hours logged in GitLab by you and your group over the last weeks, and your own entries of today, through glab or a token. Read every 5 min while a widget uses it. Options are set once in Kiosko → Settings → Data sources.

| Option | Type | Default | |
|---|---|---|---|
| `host` | string | `""` | GitLab host. Empty = glab's default host (gitlab.com with a token). |
| `token` | string | *(secret)* | Access token. A personal access token with read_api. Empty = use the glab CLI and its login. |
| `group` | string | `""` | Group. Full path of the GitLab group whose hours to show. Empty = only yours. |
| `me` | string | `""` | Your username. Empty = the logged-in user. |
| `weeks` | number | `4` | Weeks for the averages |
| `bin` | string | `"glab"` | glab command |

### Agent activity — `timesheet/activity`

Today's work blocks per project, from the agent hook's activity log (one JSONL file per day). Read every 2 min while a widget uses it. Options are set once in Kiosko → Settings → Data sources.

| Option | Type | Default | |
|---|---|---|---|
| `dir` | string | `"~/.aimonitor/actividad"` | Activity folder |
| `gapMin` | number | `15` | Gap that splits a block |
| `tailMin` | number | `5` | Time added after the last event |

## Development

```sh
npm install
npm test          # node:test
npm run check     # TypeScript
npm run build     # dist/index.js, what Kiosko loads
```

To try it in a running Kiosko without publishing: `kiosko plugins link .` and restart Kiosko.

Working on Kiosko and its plugins together: clone them side by side
(`kiosko/` and `kiosko-plugins/kiosko-plugin-timesheet/`) and run `npm install` in
`kiosko/`; its workspaces link every plugin found in `../kiosko-plugins`.

## License

MIT
