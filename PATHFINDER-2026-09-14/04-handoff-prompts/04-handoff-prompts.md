# Handoff Prompts for Unified Systems

## 1. Voice Event Helper Function

Unified component: `createVoiceEvent(base, type, channelId)` in `event-logging.js`
Single entry point: New helper function to be added at the top of `event-logging.js` (before `handleVoiceStateUpdate`)

Exact call sites to rewrite:
- `event-logging.js:211-218` (voice leave event creation)
- `event-logging.js:219-226` (voice join event creation)

Relevant flowchart: `01-flowcharts/event-logging-system.md`

Anti-pattern guards:
- Do not add parameters for specific voice event types; keep the function generic.
- Do not embed voice-specific logic inside the helper; it should only construct the event object.
- Do not change the function to return anything other than the event object.

```
/make-plan Implement a unified voice event helper function in event-logging.js to eliminate duplication in handleVoiceStateUpdate. The function should take base event data, event type ('voice_leave' or 'voice_join'), and channelId, and return the completed event object. Rewrite the two voice event creation blocks in handleVoiceStateUpdate to use this helper. Preserve all existing behavior and validation.
```

## 2. Generic Pagination Function

Unified component: `paginateEvents(guildId, whereClause, whereArgs, pageSize, requestedThroughId, columns)` in `database.js`
Single entry point: New generic pagination function to be added in `database.js` (near other event query functions)

Exact call sites to rewrite:
- `database.js:161-188` (readCommandEventsPage)
- `database.js:230-252` (readInfractionsPage)
- `database.js:379-388` (readMessageEventsPage) - optional, for consistency
- `database.js:390-399` (readGeneralEventsPage) - optional, for consistency

Relevant flowchart: `01-flowcharts/database-layer.md`

Anti-pattern guards:
- Do not hardcode any table names or column lists inside the paginateEvents function.
- Do not remove the ability to specify custom WHERE clauses and columns.
- Do not change the function's return structure; it must remain compatible with existing call sites.

```
/make-plan Create a generic pagination function in database.js to consolidate duplicate pagination logic across event retrieval functions. The function should accept customizable WHERE clauses, column lists, and pagination parameters. Rewrite readCommandEventsPage and readInfractionsPage to use this new function, and consider updating readMessageEventsPage and readGeneralEventsPage for consistency. Ensure all existing filtering and pagination behavior is preserved.
```

## 3. Unified EmbedBuilder Setup

Unified component: Existing `buildLogsEmbed(title, emptyDescription, pageData, renderEvent, itemName)` in `commands.js`
Single entry point: The existing `buildLogsEmbed` function (lines 161-172)

Exact call sites to rewrite:
- `commands.js:174-206` (buildCommandLogsView) - currently duplicates EmbedBuilder setup

Relevant flowchart: `01-flowcharts/configuration-system.md` (actually, the command system flowchart is in command-system.md, but the EmbedBuilder setup is in the command system flowcharts; we'll reference the command system flowchart)

Anti-pattern guards:
- Do not modify buildLogsEmbed to be less generic; it must continue to support different titles, descriptions, and render functions.
- Do not inline any EmbedBuilder configuration in the call sites; all must delegate to buildLogsEmbed.
- Do not change the function signature or return type.

```
/make-plan Refactor buildCommandLogsView in commands.js to use the existing buildLogsEmbed helper function instead of duplicating EmbedBuilder configuration. Provide a custom render function for command events that matches the current inline implementation. Ensure the resulting embeds and components are identical to the original output.
```

## 4. Consistent Event Insertion Mechanism

Unified component: Existing `prepareEventInsert(table, sql)` in `database.js`
Single entry point: The existing prepareEventInsert function (lines 128-134)

Exact call sites to rewrite:
- `database.js:212-228` (logInfraction) - currently uses direct database.prepare

Relevant flowchart: `01-flowcharts/database-layer.md`

Anti-pattern guards:
- Do not remove the validation logic for infraction type and reason; it must remain at the start of logInfraction.
- Do not change the table name or SQL statement used for infraction insertion.
- Do not alter the return value or error handling of logInfraction.
- Do not use prepareEventInsert for tables that have different transaction requirements (if any exist).

```
/make-plan Refactor logInfraction in database.js to use the existing prepareEventInsert wrapper instead of a direct database.prepare statement. Move the validation checks (type and reason) to the beginning of the function, then call the insert function returned by prepareEventInsert. Ensure the function's behavior, including error handling and return value, remains unchanged.
```