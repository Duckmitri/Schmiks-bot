# Schmiks-bot
<img width="300" height="300" alt="download" src="https://github.com/user-attachments/assets/aa4e9ad7-0c88-4db0-92ce-f192db3b4e2e" />


Schmiks-bot is a small Discord moderation bot with an optional local configuration dashboard.

## Commands

- `!server-info` - Shows server information
- `!links` - Presents buttons for the social links configured in `config/config.json`
- `!kick @member <reason>` and `/kick target reason` - Moderator-only member kick commands
- `!warn @member <reason>` and `/warn target reason` - Moderator/admin-only warning commands
- `!infractions @member` and `/infractions target` - Moderator/admin-only public member infraction history
- React with a configured emoji (default: `🥾`) to a message - Moderator/admin-only kick of that message's author; the message text is used as the reason
- `!logs <general|messages|commands>` - Administrator-only viewer for general, message, and command events

The prefix may differ from `!` if configured.

## Setup

Requires Node.js 24 or newer and a Discord application with the Guilds, Guild Members, Guild Messages, Guild Message Reactions, Message Content, and Guild Voice States intents enabled. Message, reaction, channel, user, and guild-member partial support is enabled so the bot can fetch reaction source data when Discord makes that possible.

```powershell
npm ci
run-bot.bat
```

The bot must have the matching Discord moderation permissions and its role must be above the members it moderates.

## Reaction kick configuration

Configure reaction commands in `config/config.json`; keys may be Unicode emoji or custom emoji IDs. Only a `kick` mapping is currently routed:

```json
"reactionCommands": {
  "🥾": "kick"
}
```

When an authorized moderator or administrator adds a configured reaction to a guild message, the bot attempts to DM and then kick the message author. The message text is the kick reason; an empty message uses `You have been kicked from the server, no reason provided`. The source message receives the result, including a failed-DM warning.

## Event logging

The bot stores command, message, and general activity in a local SQLite database at `data/schmiks.db`. The directory and database are created automatically when the bot starts. Set `DATABASE_PATH` to use a different location.

Warnings and successful kicks are stored permanently in the `infractions` table; the event-log retention setting does not delete them. A warning is recorded before its DM is attempted, so a blocked or failed DM is reported publicly without losing the history entry. A kick is recorded only after Discord confirms the kick succeeded. Infraction history is limited to the current server, displays ten entries per public page, and re-checks moderator or administrator access when its Previous/Next buttons are used.

Command events record the UTC timestamp, Discord guild/channel/user IDs, interaction type, command name, outcome, duration, and a safe error category when applicable. Message snapshots and message edit/delete events store message text and attachment URLs so that edits and deletes can be shown later. This is sensitive server content: restrict access to the local database and administrator logs accordingly. Attachment URLs are stored as references only—the bot never downloads attachments—and Discord CDN URLs can expire, so an old stored URL may no longer work.

Administrators can view the server's logs publicly with `/logs type:general`, `/logs type:messages`, `/logs type:commands`, or the matching `!logs <general|messages|commands>` form. Results are limited to the current server, display ten entries per page, and use Previous/Next buttons. The pagination buttons re-check the configured administrator roles and keep a stable snapshot while navigating. `/logs` is always registered with all three choices even when the other slash commands come from `config/config.json`. An empty `adminRoleId` list disables access for everyone.

The dashboard configures moderator and administrator role IDs, one per line, plus one shared Discord log channel ID, retention days, and seven independent live-delivery switches: command execution, message edit, message delete, member join, member leave, voice join, and voice leave. It also configures the warning embed color, title, and message. Warning title/message templates substitute exactly `{server}` with the guild name, `{reason}` with the stored reason, and `{moderator}` with the moderator's Discord tag; other brace-delimited text remains literal. Each event also has its own color picker; click the swatch, choose a color, and save. Colors are stored as `#RRGGBB` values under `logging.colors` and take effect on new live log embeds immediately. The database collection remains active regardless of the delivery switches; they control only whether an already-recorded event is posted live to the configured channel. Delivery requires that channel to allow the bot to view the channel, send messages, and embed links. Delivery failures are logged and do not stop command processing or event collection.

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

<img width="1859" height="928" alt="dashboard-sc" src="https://github.com/user-attachments/assets/dd6915dd-2d4b-492a-9bc3-fd85d932f3cb" />



## Development workflow

1. Run `npm ci` after dependency changes or a fresh checkout.
2. Make the smallest focused change.
3. Run `npm run check` before handing off.
4. Update `README.md` and `HANDOFF.md` when commands, configuration, or architecture change.

`npm run check` verifies repository syntax and automated tests. It does not verify live Discord slash-command registration, role/permission behavior, public message visibility, kicks, or DM delivery; check those manually in a test server.

See [HANDOFF.md](HANDOFF.md) for the code map, invariants, and agent handoff checklist.
