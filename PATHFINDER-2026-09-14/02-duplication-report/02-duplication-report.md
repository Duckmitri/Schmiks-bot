# Duplication Report

## Within-Feature Duplication

### Event Logging System (event-logging.js)
**Concern**: Duplicate code blocks for creating voice leave and voice join events in `handleVoiceStateUpdate` function.

**Locations**:
- `event-logging.js:211-218` (voice leave event creation)
- `event-logging.js:219-226` (voice join event creation)

**Details**: Both code blocks:
- Spread the same `base` object
- Set a `type` field (either 'voice_leave' or 'voice_join')
- Set a `channelId` field using `String()` conversion on either `oldChannelId` or `newChannelId`

**Consolidation Opportunity**: Extract a helper function like `createVoiceEvent(base, type, channelId)` that returns the event object.

## Cross-Feature Duplication

### 1. Pagination Logic Duplication
**Concern**: Nearly identical pagination logic appears in two event retrieval functions.

**Locations**:
- `database.js:161-188` (readCommandEventsPage)
- `database.js:230-252` (readInfractionsPage)

**Divergence**: 
- readCommandEventsPage filters by `interaction_type IN ('prefix', 'slash')` 
- readInfractionsPage filters by `target_user_id = ?`
- readInfractionsPage includes page size normalization logic missing in readCommandEventsPage

**Assessment**: **Accidental**. The WHERE clause differences are legitimate (different filtering requirements), but the pagination mechanism itself should be shared. Both functions should use a generic pagination helper with customizable WHERE clauses and columns, like readMessageEventsPage and readGeneralEventsPage do via readEventsPage.

### 2. EmbedBuilder Setup Duplication
**Concern**: Duplicate EmbedBuilder configuration logic in log view builders.

**Locations**:
- `commands.js:174-206` (buildCommandLogsView)
- `commands.js:208-221` (buildMessageLogsView)
- `commands.js:223-247` (buildGeneralLogsView)

**Divergence**: 
buildMessageLogsView and buildGeneralLogsView correctly delegate common EmbedBuilder setup to the buildLogsEmbed helper function (lines 161-172), but buildCommandLogsView reimplements this logic inline. All three functions set identical title, color, description structure, footer format, and timestamp.

**Assessment**: **Accidental**. The event rendering logic (which differs per log type) is correctly separated into render functions, but the EmbedBuilder boilerplate is duplicated in buildCommandLogsView. This function should also use buildLogsEmbed with a custom render function for command events, aligning with the pattern used by the other two builders.

### 3. Event Logging Mechanism Inconsistency
**Concern**: Inconsistent implementation mechanisms for event logging functions.

**Locations**:
- `database.js:146-159` (logCommandEvent)
- `database.js:212-228` (logInfraction)
- `database.js:320-333` (logMessageEvent)
- `database.js:343-352` (logGeneralEvent)

**Divergence**: 
logCommandEvent, logMessageEvent, and logGeneralEvent all use the prepareEventInsert wrapper (which creates a transaction), while logInfraction uses a direct database.prepare statement plus manual validation. The validation in logInfraction (checking type and reason) is legitimate, but the different insertion mechanism appears to be an oversight.

**Assessment**: **Mostly accidental**. The validation logic in logInfraction is a legitimate specialization (infracts require stricter validation), but the core insertion mechanism should be consistent. logInfraction should use prepareEventInsert like the others, with validation applied before calling the insert function. This would align all four logging functions to the same pattern while preserving necessary validation.