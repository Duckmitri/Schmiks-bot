# Infractions System Design

## Scope

Add persistent moderation infractions to Schmiks. Warnings and successful kicks create records. Moderators can publicly view a member's history through prefix and slash commands. Warning DM appearance is configurable from a dedicated dashboard section.

## Commands and authorization

- `warn` is a moderator command with required `target` and `reason` arguments.
- `infractions` is a moderator command with a required `target` argument.
- Administrator roles continue to inherit moderator-command access through the existing role check.
- Prefix and slash invocations use the existing command routing and command-audit paths.
- The `infractions` response is public for both command forms.

## Infraction storage

Add an `infractions` table to the existing SQLite database. Each row stores:

- guild ID
- target user ID
- moderator user ID
- infraction type (`warn` or `kick`)
- reason
- creation timestamp

Discord IDs remain SQLite `TEXT` values. Reads are scoped by guild and target user, sorted newest first, and paginated using the existing ten-item page convention. Infractions are durable moderation history and are not removed by event-log retention cleanup.

A warning is recorded once the moderator successfully issues it, even when Discord rejects the DM. A kick is recorded only after Discord confirms the kick. Failed validation, authorization, warning execution, and kick attempts do not create infraction rows.

## Warning behavior

The warning command builds a yellow embed from the current dashboard configuration and attempts to DM it to the target. The moderator receives a success response that distinguishes successful DM delivery from failed DM delivery.

The configurable fields are:

- embed color, defaulting to Discord yellow (`#FEE75C`)
- title template
- message template

Title and message templates support exactly these substitutions:

- `{server}`: current guild name
- `{reason}`: supplied warning reason
- `{moderator}`: moderator display label

Unknown placeholders remain literal text. Discord embed limits are enforced after substitution. Configuration validation rejects invalid colors, non-string templates, and blank templates.

## Kick integration

The existing shared kick executor remains responsible for DM and kick behavior. After it reports a successful kick, each direct or reaction caller writes one kick infraction using the same target, moderator, guild, and bounded reason. This keeps reaction kicks and direct kicks consistent without recording failed attempts.

## Infractions display

The `infractions` command posts a public embed containing the selected member and their newest infractions. Each item shows the infraction type, reason, responsible moderator, and Discord timestamp. Previous and Next buttons use the existing stable-snapshot pagination approach and re-check moderator authorization on every click. An empty history produces a normal public embed rather than an error.

## Dashboard and configuration

Add a dedicated Infractions navigation item and settings section to the existing dashboard. It follows the current macOS Settings-inspired design: grouped settings rows, existing typography and spacing, native color control behavior, and current responsive layout.

The dashboard `/api/config` response and update payload gain a `warningEmbed` object containing `color`, `title`, and `message`. The existing config reader supplies defaults when the object is absent, so current local configuration remains valid. Saves preserve unrelated configuration fields.

## Error handling

- Invalid targets or missing reasons receive usage feedback and create no infraction.
- A warning DM failure is reported but does not undo the stored warning.
- Database failure prevents a warning from being reported as successfully issued.
- A completed kick is not reversed if infraction persistence fails; the command reports the persistence failure and logs it.
- Pagination rejects malformed button state and unauthorized users without exposing history.

## Verification

Add focused tests for schema persistence, guild/target filtering, pagination, template validation and substitution, warning DM outcomes, successful kick recording, failed kick exclusion, command authorization, slash definitions, public responses, and dashboard API round-tripping. Run `npm run check` as the repository gate. Live Discord registration, DMs, permissions, and role hierarchy remain manual verification items.
