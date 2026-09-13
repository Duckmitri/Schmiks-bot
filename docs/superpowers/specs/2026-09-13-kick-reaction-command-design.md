# Kick and Reaction Command Design

## Scope

Add a moderator-only `kick` command for prefix, slash, and configured message-reaction invocation. The first reaction mapping is the Unicode boot emoji (`🥾`), configurable for later replacement.

## Command behavior

- Prefix syntax: `!kick @target reason`.
- Slash syntax: `/kick target reason`; both options are required.
- Reaction syntax: a moderator or administrator reacts with configured `🥾` to a guild message. The message author is the target and its text is the reason.
- Empty reacted-message text uses: `You have been kicked from the server, no reason provided`.
- Before kicking, the bot attempts to DM the target a red embed naming the server and reason. A failed DM is reported but does not block the kick.
- Discord's `GuildMember#kickable` check rejects owner, hierarchy, and permission failures before attempting the action.
- Successful and failed invocations use the existing command-audit logging path.

## Reaction routing

`config/config.json` gains a minimal command map:

```json
"reactionCommands": {
  "🥾": "kick"
}
```

`config.js` reads that map. `bot.js` enables guild message reactions and routes `messageReactionAdd` to one exported handler in `commands.js`. The handler fetches partial reaction/message data when necessary, ignores bot reactors and non-guild messages, resolves the reactor's guild member, checks moderator/admin roles, and dispatches only registered reaction commands.

The registry initially supports only `kick`; adding another reaction command requires an explicit handler entry rather than synthesizing fake Discord messages.

## Safety and feedback

- The bot cannot kick itself, the guild owner, or an unkickable member.
- Missing target/member data and unauthorized reactions do not execute moderation actions.
- Prefix/slash validation requires a target and reason; reaction invocation alone receives the documented fallback reason.
- The source channel receives a concise outcome, including whether DM delivery failed.

## Verification

Tests cover prefix/slash argument extraction, moderator authorization, DM-before-kick ordering, DM failure continuation, fallback reaction reason, configurable emoji dispatch, and ignored unauthorized/bot reactions. Final verification is `npm run check`.
