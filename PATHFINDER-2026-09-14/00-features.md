# Feature Inventory

## Bot Core
- **Entry point**: `bot.js:1`
- **Core files**: `bot.js`
- **Purpose**: Initializes Discord client, sets up intents and partials, handles ready event, registers slash commands, connects to Discord

## Command System
- **Entry point**: `commands.js:625 (handlePrefixCommand)`, `commands.js:689 (handleSlashCommand)`
- **Core files**: `commands.js`
- **Purpose**: Processes prefix and slash commands, checks permissions, routes to appropriate command handlers, implements audit logging

## Moderation Commands
- **Entry point**: `commands.js:405 (commandHandlers object)`
- **Core files**: `commands.js` (server-info, links, kick, warn, infractions, logs handlers)
- **Purpose**: Implements moderator/administrator commands for server management including kick, warn, server info, link sharing, infraction viewing, and log viewing

## Infraction System
- **Entry point**: `database.js:204 (insertInfraction)`, `database.js:212 (logInfraction)`
- **Core files**: `database.js`
- **Purpose**: Stores warnings and kicks in infractions table with permanent retention, provides pagination for viewing history

## Event Logging System
- **Entry point**: `event-logging.js:96 (snapshotMessage)`, `event-logging.js:103 (handleMessageUpdate)`, `event-logging.js:142 (handleMessageDelete)`
- **Core files**: `event-logging.js`, `database.js` (event logging functions)
- **Purpose**: Captures command executions, message edits/deletes, and member/voice events; stores in database; optionally delivers to configured log channel

## Configuration System
- **Entry point**: `config.js:30 (readConfig)`, `config.js:46 (readPrefix)`, `config.js:89 (readLoggingConfig)`, etc.
- **Core files**: `config.js`
- **Purpose**: Manages bot configuration including prefix, role IDs, logging settings, warning embed configuration, links, and slash commands; provides dashboard integration

## Reaction Commands
- **Entry point**: `commands.js:349 (handleMessageReactionAdd)`
- **Core files**: `commands.js`
- **Purpose**: Allows moderators to kick users by reacting to their messages with configured emojis

## Rate Limiting
- **Entry point**: `bot.js:29 (createRateLimiter)`, `bot.js:97 (allowCommand)`, `bot.js:153 (allowButton)`
- **Core files**: `rate-limit.js`, `bot.js`
- **Purpose**: Prevents command and button spam by limiting usage to once every 2 seconds per user

## Database Layer
- **Entry point**: `database.js:11 (database initialization)`
- **Core files**: `database.js`
- **Purpose**: Manages SQLite database schema and connections; provides tables for command events, message snapshots, message events, general events, and infractions; includes indices and retention cleanup

## Dashboard
- **Entry point**: Referenced in README.md:66-74
- **Core files**: Not in current source (external dashboard)
- **Purpose**: Web interface for configuring bot settings including prefix, role IDs, logging configuration, and warning embeds; binds to localhost only