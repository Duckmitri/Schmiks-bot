# Complete Logging System Design

## Purpose

Extend Schmiks' existing SQLite command audit system to persist message edits and deletions, member joins and leaves, and voice-channel joins and leaves. Administrators can browse all three log categories through `/logs` or `!logs`, and the web dashboard can optionally deliver each individual event type to one shared Discord channel.

## Scope

The system records these seven event types:

- `command_execution`
- `message_edit`
- `message_delete`
- `member_join`
- `member_leave`
- `voice_join`
- `voice_leave`

The dashboard controls live delivery for each event independently. Delivery settings never disable database collection. Bot-authored messages are excluded from message snapshots and message events so the bot cannot log its own log messages recursively.

## Configuration

The existing JSON configuration gains a `logging` object:

```json
{
  "logging": {
    "channelId": "",
    "retentionDays": 90,
    "delivery": {
      "commandExecution": false,
      "messageEdit": false,
      "messageDelete": false,
      "memberJoin": false,
      "memberLeave": false,
      "voiceJoin": false,
      "voiceLeave": false
    }
  }
}
```

`retentionDays` defaults to `90` and accepts whole numbers from 1 through 3650. `channelId` is either empty or a Discord snowflake containing 17 through 20 digits. An empty channel ID is valid only when every delivery switch is disabled.

Dashboard reads and writes merge the logging settings with the complete existing JSON document. Updating the prefix or logging settings must preserve role IDs, links, slash commands, and unknown forward-compatible keys. `BOT_PREFIX` continues to override only the prefix and does not prevent logging settings from being saved.

The dashboard form contains the command prefix, shared log-channel ID, retention-days input, and one checkbox for every delivery event. Server validation is authoritative and the client displays validation or save errors.

## Database Design

The existing `command_events` table remains the source for command history.

`message_snapshots` contains the latest known state of every non-bot guild message:

- message ID primary key
- guild ID, channel ID, and author ID
- author display label when available
- content text
- attachment URLs encoded as JSON
- Discord creation timestamp
- last observed update timestamp
- deletion timestamp, nullable

`message_events` is an append-only edit/delete history:

- integer primary key
- occurrence timestamp
- guild ID, channel ID, message ID, and author ID
- event type constrained to `message_edit` or `message_delete`
- before and after content, with after content nullable for deletion
- before and after attachment URL JSON, with after attachments nullable for deletion

`general_events` is an append-only member/voice history:

- integer primary key
- occurrence timestamp
- guild ID and user ID
- user display label when available
- event type constrained to `member_join`, `member_leave`, `voice_join`, or `voice_leave`
- channel ID, nullable for member events

Indexes support guild/category pagination, retention deletion, and message lookup. Schema creation is additive and idempotent so existing databases upgrade at startup without losing command history.

Every log category uses a maximum event ID captured when page zero is opened. Subsequent pages query only IDs at or below that boundary, preventing new records from reshuffling an open result set.

## Discord Event Flow

The client enables the existing guild, member, message, and message-content intents plus `GuildVoiceStates`. Message partial support is enabled so deletion events can be correlated by ID when Discord does not provide message content.

On `messageCreate`, the bot upserts a snapshot for each non-bot guild message. The snapshot stores text and attachment URLs even when live message delivery is disabled.

On `messageUpdate`, the bot resolves the before-state from SQLite first and falls back to Discord's cached old message. It fetches a partial new message when possible, records a `message_edit` only when content or attachment URLs changed, then updates the snapshot. The database write happens before optional channel delivery.

On `messageDelete`, the bot resolves content and attachments from SQLite first and falls back to the Discord event object. It records `message_delete`, marks the snapshot deleted, and then attempts optional delivery. If only the message ID is known, the event is still stored with unavailable content represented as empty text.

On `guildMemberAdd` and `guildMemberRemove`, the bot records member join or leave with the best available display label.

On `voiceStateUpdate`, no event is recorded when the channel ID did not change. A null-to-channel transition records `voice_join`; channel-to-null records `voice_leave`; changing channels records a leave for the old channel followed by a join for the new channel.

The existing command audit function records the command event first and then requests optional `command_execution` delivery. Delivery failure never changes the stored command's success result.

All event listeners catch and report failures without rejecting through Discord's event emitter or terminating the bot.

## Live Channel Delivery

All enabled event types post to the single configured channel. The delivery service reads current settings for each event, so dashboard changes take effect without restarting the bot.

For an enabled event, the service fetches the configured channel from the relevant guild and verifies it is text-based and sendable. It sends a compact `EmbedBuilder` payload containing event type, user, source channel when relevant, timestamp, and event-specific details. Message content, before/after values, and attachment links are truncated to remain within Discord field and total embed limits.

Missing channels, inaccessible channels, missing send permissions, malformed configuration, or API failures are written to the console. They do not roll back database records or crash the bot.

## Logs Command

The existing built-in slash choices remain `general`, `messages`, and `commands`, and the prefix form remains `!logs <general|messages|commands>`.

`commands` continues to read `command_events`. `messages` reads combined edit/delete events. `general` reads combined member/voice events. Every view is limited to the current guild, orders newest first, displays a clean rich embed, and includes Previous and Next buttons.

Each page considers at most ten records. Rendering also enforces Discord's 4096-character description limit, 1024-character field limit, 25-field limit, and 6000-character total embed limit. Individual message excerpts and attachment lists are truncated with an explicit ellipsis or omitted-count marker. Empty categories display a category-specific empty-state message.

Pagination custom IDs encode category, requested page, and stable through-ID. Every page click reloads configured administrator role IDs and rejects unauthorized users ephemerally. Database or rendering failures receive a concise ephemeral error without replacing the public log message.

## Retention

At bot startup and once every 24 hours, a cleanup job reads the current `retentionDays` value and deletes data older than the computed cutoff from `command_events`, `message_events`, `general_events`, and `message_snapshots`. Deleted-message snapshots follow the same cutoff and are not removed immediately because they remain useful during the retention window.

The interval is unreferenced so it cannot keep Node.js alive during shutdown. Cleanup errors are logged and do not stop startup or event processing. Changing retention in the dashboard affects the next cleanup without restart.

## Testing

Automated tests use temporary config and database paths. Coverage includes:

- additive schema creation and message snapshot upserts
- edit/delete history with text and attachment URLs
- cached and partial message fallbacks
- member join/leave and voice join/leave, including channel moves
- per-guild query isolation and stable pagination
- log embeds staying within Discord limits
- administrator authorization on commands and page buttons
- default configuration and validation boundaries
- dashboard GET/POST round trips that preserve unrelated JSON keys
- each delivery switch enabled and disabled independently
- absent or inaccessible delivery channels
- startup and scheduled retention deletion
- listener failures remaining contained

The full `npm run check` command remains the completion gate for syntax and test verification.

## Operational Notes

Message text and attachment URLs are intentionally retained for the configured period. Attachment URLs may stop working after deletion because Discord controls their lifetime; the system preserves the URL but does not download attachment files. Discord events that happened while the bot was offline cannot be reconstructed. The snapshot strategy makes later deletions reliable across bot restarts only for messages the bot observed while online.
