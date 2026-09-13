# Handoff

## Kick routing

- `commands.js` exports `executeKick({ guild, target, reason })`; direct prefix/slash and reaction paths share it. It checks `kickable`, attempts the red DM before kicking, and continues if the DM fails.
- `handleMessageReactionAdd(reaction, user)` resolves partial reactions/messages, uses `reaction.emoji.id ?? reaction.emoji.name`, and only routes configured `kick` mappings.
- The reactor is fetched as a guild member and must hold any configured moderator or administrator role. The reacted message author is fetched as the target.
- Reaction reasons use trimmed message content, or exactly `You have been kicked from the server, no reason provided` when empty.

## Discord and configuration

- `bot.js` requires the Guild Message Reactions gateway intent and Channel, Reaction, User, Message, and GuildMember partials. It routes `messageReactionAdd` into `handleMessageReactionAdd` and logs unhandled errors.
- `config.reactionCommands` maps a Unicode emoji or custom emoji ID to a command. Only `kick` is supported; other or missing mappings return `false` without moderation side effects.

## Audit behavior

- Routed reaction kicks call the existing `auditInteraction` path with `interactionType: 'reaction'`, the reactor as the user, and the source guild/channel IDs. This records and can deliver command execution audit events.
- Administrator command-log pages intentionally continue to query only prefix/slash rows; reaction audit rows are not displayed there.

## Verification

- Run `npm run check`. These are source-level tests only; confirm Discord intents, role hierarchy, DM delivery, and live reaction handling in a server before treating runtime behavior as verified.
