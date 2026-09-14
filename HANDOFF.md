# Handoff

## Infraction commands

- `commands.js` routes `!warn @member <reason>` / `/warn target reason` and `!infractions @member` / `/infractions target` through the existing moderator command gate. A configured moderator or administrator role is accepted; with both role lists empty, access is disabled.
- Warning command replies and infraction history are public. History is scoped to the current guild and target member, uses ten-entry snapshot-stable pages, and re-checks moderator/administrator roles on Previous/Next clicks.
- `executeWarn` stores a bounded reason before attempting the configured DM. DM failure therefore returns success with `dmDelivered: false`, keeps the infraction, and produces `The warning was recorded, but their DM notification failed.`
- `executeKick` attempts the DM, performs the kick, and records the infraction only after the kick succeeds. A DM failure does not block a successful kick; a failed kick is not recorded.

## Configuration

- `warningEmbed` is read and written through `config.js` and `/api/config`. The dashboard exposes color, title, and message fields; color must be `#RRGGBB`, and title/message must be nonblank.
- Warning title/message templates replace exactly `{server}` with the guild name, `{reason}` with the stored warning reason, and `{moderator}` with the moderator's Discord tag. Unknown placeholders remain literal.

## Database and retention

- `database.js` creates `infractions(id, occurred_at, guild_id, target_user_id, moderator_user_id, type, reason)` plus `infractions_guild_target_idx`. `type` is constrained to `warn` or `kick`.
- Event retention deletes from `command_events`, `message_events`, `general_events`, and `message_snapshots` only. Infractions are permanent unless an operator deletes them directly.

## Verification boundary

- Run `npm run check` for JavaScript syntax checks and the complete automated test suite.
- Run `git diff --check` and inspect `git status --short` before handoff.
- Repository checks do not verify live Discord slash-command registration, role hierarchy/permissions, public history rendering, successful kick behavior, or DM delivery. Verify those manually in a test server before treating live behavior as confirmed.
