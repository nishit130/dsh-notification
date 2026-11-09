# dsh-notification

> Desktop, browser + webhook notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> on **macOS · Linux · Windows**: know when your agent **finishes a turn**, **hits an error**,
> or is **waiting for your approval** — without watching the tab.

Long agent turns are the norm: you kick off a task, switch away, and come back to find the agent
finished five minutes ago — or worse, stuck on an approval prompt the whole time. `dsh-notification`
listens to the harness's own lifecycle events and pings you the moment your attention is needed.

## What it does

| Event | Trigger | Default |
|---|---|---|
| **Agent finished** | `agent/status` flips `running → idle`, and the turn ran ≥ `minTurnDurationMs` | on |
| **Agent error** | `agent/error` (a step or turn errored) | on |
| **Approval needed** | `approval/request` waterfall (observe-only; always delegates with `next()`) | on |

Each event can go to:
- **Desktop notification** — zero dependencies: `osascript` (macOS), `notify-send` (Linux),
  PowerShell toast (Windows).
- **Webhook** — a JSON `POST` with a Slack-compatible `text` field, so a Slack/Discord/generic
  incoming-webhook URL works out of the box.

## Install

```sh
dsh plugin --profile web add dsh-notification
# or straight from git:
dsh plugin --profile web add github:nishit130/dsh-notification
```

The package ships plain ESM JavaScript — no build step, so a git install needs no
`allowBuilds` entry.

## Where notifications appear

Three channels, three places:

| Channel | Fires on | Best for |
|---|---|---|
| Desktop (`desktop`) | the machine **running the `dsh` server** | `dsh web` on your own machine |
| Browser (`browser`) | the machine **viewing the Web UI** | a remote server, or any Web UI use |
| Webhook (`webhookUrl`) | wherever the URL points | phones, Slack, unattended runs |

Browser notifications use the standard `Notification` API: the Web UI asks for permission on
your first click or keypress, and by default popups appear **only while the window is hidden or
unfocused** — a window you are looking at already has your attention (set
`browserOnlyWhenHidden: false` to change that).

Each popup names the Session that raised it, and **clicking it opens that conversation**: the
main view switches back to the Conversation panel and remembers the Session, so a reload returns
to it. Popups are kept one per Session, so a second Session finishing does not replace an unread
"needs you" popup. The host-side desktop channel cannot do this — a `display notification` has no
click action to hang an open on.

Running everything on one machine with the window hidden? You'd get both a desktop and a browser
popup for the same event — turn one channel off (`desktop: false` or `browser: false`) if the
pair bothers you.

## Configuration

Override the row in your profile's `cordis.patch.yml` (or via the Settings UI):

```yaml
- insert:
    - id: notify
      name: dsh-notification
      config:
        minTurnDurationMs: 10000        # only notify for turns ≥ 10s
        webhookUrl: 'https://hooks.slack.com/services/XXX/YYY/ZZZ'
        notifyOnApproval: true
        desktop: true
        title: 'DSH'
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `notifyOnIdle` | boolean | `true` | Notify when a turn finishes |
| `notifyOnError` | boolean | `true` | Notify on `agent/error` |
| `notifyOnApproval` | boolean | `true` | Notify when a tool call awaits approval |
| `minTurnDurationMs` | number | `5000` | Skip notifications for quick turns |
| `desktop` | boolean | `true` | Native desktop notification on the server host |
| `browser` | boolean | `true` | Browser `Notification` popups in the Web UI |
| `browserOnlyWhenHidden` | boolean | `true` | Suppress browser popups while the window is visible and focused |
| `webhookUrl` | string | `''` | Optional POST target (Slack-compatible payload) |
| `title` | string | `'DeepSeek Harness'` | Desktop notification title |

### Webhook payload

```json
{
  "text": "Agent finished — done in 2m 14s",
  "summary": "Agent finished",
  "body": "done in 2m 14s",
  "level": "info",
  "ts": "2026-08-21T12:34:56.000Z"
}
```

## Design notes

- **Everything registered through `ctx` is an effect** — the listeners are removed automatically
  on unload/hot-reload; there is no manual cleanup path (Cordis revertible effects).
- **`approval/request` is a waterfall.** This plugin only observes it, so its listener always
  calls `next()` — returning without it would claim the decision and swallow the real answerers.
- **Never break the loop.** Desktop spawns are detached and fire-and-forget; webhook failures are
  swallowed. A notifier must never surface an error into the agent's turn.

## Local development

Copy `dev.patch.example.yml` to `dev.patch.yml` (gitignored), point it at your checkout's
absolute path, then from a harness source checkout:

```sh
pnpm dsh web --patch ./path/to/dsh-notification/dev.patch.yml
```

Edits to `index.js` hot-reload without a restart. Run the tests with `npm test`.

## License

MIT
