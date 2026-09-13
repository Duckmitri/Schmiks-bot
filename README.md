# Schmiks-bot
<img width="300" height="300" alt="download" src="https://github.com/user-attachments/assets/aa4e9ad7-0c88-4db0-92ce-f192db3b4e2e" />


Schmiks-bot is a small Discord moderation bot with an optional local configuration dashboard.

## Commands

- `!server-info` - Shows server information
- `!links` - Presents buttons for the social links configured in `config/config.json`
- `!logs <general|messages|commands>` - Administrator-only viewer for general, message, and command events

The prefix may differ from `!` if configured.

## Setup

Requires Node.js 24 or newer and a Discord application with the Guilds, Guild Members, Guild Messages, Message Content, and Guild Voice States intents enabled. Message partial support is enabled so the bot can fetch a partial updated message when Discord makes that possible.

```powershell
npm ci
run-bot.bat
```

The bot must have the matching Discord moderation permissions and its role must be above the members it moderates.

## Event logging

The bot stores command, message, and general activity in a local SQLite database at `data/schmiks.db`. The directory and database are created automatically when the bot starts. Set `DATABASE_PATH` to use a different location.

Command events record the UTC timestamp, Discord guild/channel/user IDs, interaction type, command name, outcome, duration, and a safe error category when applicable. Message snapshots and message edit/delete events store message text and attachment URLs so that edits and deletes can be shown later. This is sensitive server content: restrict access to the local database and administrator logs accordingly. Attachment URLs are stored as references only—the bot never downloads attachments—and Discord CDN URLs can expire, so an old stored URL may no longer work.

Administrators can view the server's logs publicly with `/logs type:general`, `/logs type:messages`, `/logs type:commands`, or the matching `!logs <general|messages|commands>` form. Results are limited to the current server, display ten entries per page, and use Previous/Next buttons. The pagination buttons re-check the configured administrator roles and keep a stable snapshot while navigating. `/logs` is always registered with all three choices even when the other slash commands come from `config/config.json`. An empty `adminRoleId` list disables access for everyone.

The dashboard configures moderator and administrator role IDs, one per line, plus one shared Discord log channel ID, retention days, and seven independent live-delivery switches: command execution, message edit, message delete, member join, member leave, voice join, and voice leave. Each event also has its own color picker; click the swatch, choose a color, and save. Colors are stored as `#RRGGBB` values under `logging.colors` and take effect on new live log embeds immediately. The database collection remains active regardless of the delivery switches; they control only whether an already-recorded event is posted live to the configured channel. Delivery requires that channel to allow the bot to view the channel, send messages, and embed links. Delivery failures are logged and do not stop command processing or event collection.

Retention defaults to 90 days and can be set in the dashboard from 1 through 3650 whole days. Cleanup runs when the bot becomes ready and then daily. Bot-authored messages are excluded, and activity while the bot is offline cannot be reconstructed.

You can inspect the database with any SQLite client. For example:

```sql
SELECT occurred_at, user_id, interaction_type, command_name, success, error_code
FROM command_events
ORDER BY id DESC
LIMIT 100;
```

## Dashboard Usage

```powershell
npm run dashboard
```

Open `http://127.0.0.1:3000`. The dashboard binds only to the local machine and edits the prefix, role IDs, and logging settings in `config/config.json`; the bot reads those values as events occur, so changes take effect immediately.

Configuration precedence is `BOT_PREFIX`, then `config/config.json`, then `!`. Set `CONFIG_PATH` to store the JSON file elsewhere and `PORT` to change the dashboard port. If `BOT_PREFIX` is set, the dashboard cannot override it.


This is the web dashboard, you can manipulate a bunch of configuartions for the bot directly.

<img width="591" height="756" alt="dashboard-sc" src="https://github.com/user-attachments/assets/14b3e947-d73e-4d0c-a599-8a9118c87561" />


The color picker supports RGB, HSL, and HEX formats for color, you can also use the provided color picker

<img width="637" height="338" alt="colors-sc" src="https://github.com/user-attachments/assets/6e91ac54-a335-4f70-a55a-360a1a4855ac" />


## Development workflow

1. Run `npm ci` after dependency changes or a fresh checkout.
2. Make the smallest focused change.
3. Run `npm run check` before handing off.
4. Update `README.md` and `HANDOFF.md` when commands, configuration, or architecture change.

See [HANDOFF.md](HANDOFF.md) for the code map, invariants, and agent handoff checklist.
