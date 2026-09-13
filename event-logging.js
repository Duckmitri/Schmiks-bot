const { EmbedBuilder } = require('discord.js');
const { readLoggingConfig } = require('./config');
const {
  logGeneralEvent,
  logMessageEvent,
  markMessageSnapshotDeleted,
  purgeExpiredEvents,
  readMessageSnapshot,
  upsertMessageSnapshot
} = require('./database');

const deliveryConfigKeys = {
  command_execution: 'commandExecution',
  message_edit: 'messageEdit',
  message_delete: 'messageDelete',
  member_join: 'memberJoin',
  member_leave: 'memberLeave',
  voice_join: 'voiceJoin',
  voice_leave: 'voiceLeave'
};

const eventTitles = {
  command_execution: 'Command Execution',
  message_edit: 'Message Edited',
  message_delete: 'Message Deleted',
  member_join: 'Member Joined',
  member_leave: 'Member Left',
  voice_join: 'Voice Channel Joined',
  voice_leave: 'Voice Channel Left'
};

function attachmentUrls(message) {
  if (!message?.attachments) return [];
  const attachments = typeof message.attachments.values === 'function'
    ? [...message.attachments.values()]
    : Array.isArray(message.attachments) ? message.attachments : [];
  return attachments
    .map(attachment => attachment?.url ?? attachment?.proxyURL)
    .filter(url => typeof url === 'string' && url);
}

function displayLabel(subject) {
  return subject?.displayName
    ?? subject?.member?.displayName
    ?? subject?.user?.globalName
    ?? subject?.author?.globalName
    ?? subject?.user?.tag
    ?? subject?.author?.tag
    ?? subject?.user?.username
    ?? subject?.author?.username
    ?? null;
}

function validDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function messageData(message, fallbackGuild) {
  const createdAt = validDate(message?.createdAt ?? message?.createdTimestamp);
  const updatedAt = validDate(
    message?.editedAt ?? message?.editedTimestamp ?? message?.createdAt ?? message?.createdTimestamp,
    createdAt
  );
  return {
    messageId: String(message?.id ?? ''),
    guildId: String(message?.guildId ?? message?.guild?.id ?? fallbackGuild?.id ?? ''),
    channelId: String(message?.channelId ?? message?.channel?.id ?? 'unknown'),
    authorId: String(message?.author?.id ?? message?.member?.id ?? 'unknown'),
    authorLabel: displayLabel(message),
    content: typeof message?.content === 'string' ? message.content : '',
    attachmentUrls: attachmentUrls(message),
    createdAt,
    updatedAt
  };
}

function snapshotData(snapshot) {
  return {
    messageId: snapshot.message_id,
    guildId: snapshot.guild_id,
    channelId: snapshot.channel_id,
    authorId: snapshot.author_id,
    authorLabel: snapshot.author_label,
    content: snapshot.content,
    attachmentUrls: JSON.parse(snapshot.attachment_urls_json),
    createdAt: snapshot.created_at,
    updatedAt: snapshot.updated_at
  };
}

function arraysEqual(first, second) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

async function snapshotMessage(message) {
  if (!message?.guild || message.author?.bot) return;
  const snapshot = messageData(message);
  if (!snapshot.messageId || !snapshot.guildId) return;
  upsertMessageSnapshot(snapshot);
}

async function handleMessageUpdate(oldMessage, newMessage) {
  let current = newMessage;
  if (current?.partial && typeof current.fetch === 'function') {
    try {
      current = await current.fetch();
    } catch (error) {
      console.error('Could not fetch partial message update:', error);
      return;
    }
  }

  const guild = current?.guild ?? oldMessage?.guild;
  if (!guild || current?.author?.bot || oldMessage?.author?.bot) return;
  const currentData = messageData(current, guild);
  if (!currentData.messageId || !currentData.guildId) return;

  const stored = readMessageSnapshot(currentData.messageId, currentData.guildId);
  const before = stored ? snapshotData(stored) : messageData(oldMessage);
  if (before.content === currentData.content && arraysEqual(before.attachmentUrls, currentData.attachmentUrls)) return;

  const event = {
    guildId: currentData.guildId,
    channelId: currentData.channelId,
    messageId: currentData.messageId,
    authorId: currentData.authorId,
    userId: currentData.authorId,
    userLabel: currentData.authorLabel,
    type: 'message_edit',
    beforeContent: before.content,
    afterContent: currentData.content,
    beforeAttachmentUrls: before.attachmentUrls,
    afterAttachmentUrls: currentData.attachmentUrls,
    timestamp: currentData.updatedAt
  };
  logMessageEvent(event);
  upsertMessageSnapshot(currentData);
  await deliverLogEvent(guild, event.type, event);
}

async function handleMessageDelete(message) {
  const guild = message?.guild;
  if (!guild || message.author?.bot || !message?.id) return;
  const guildId = String(message.guildId ?? guild.id ?? '');
  if (!guildId) return;
  const stored = readMessageSnapshot(String(message.id), guildId);
  const before = stored ? snapshotData(stored) : messageData(message);
  const timestamp = new Date();
  const event = {
    guildId,
    channelId: before.channelId || 'unknown',
    messageId: String(message.id),
    authorId: before.authorId || 'unknown',
    userId: before.authorId || 'unknown',
    userLabel: before.authorLabel,
    type: 'message_delete',
    beforeContent: before.content,
    afterContent: null,
    beforeAttachmentUrls: before.attachmentUrls,
    afterAttachmentUrls: null,
    timestamp
  };
  logMessageEvent(event);
  markMessageSnapshotDeleted(event.messageId, guildId, timestamp);
  await deliverLogEvent(guild, event.type, event);
}

function memberEvent(member, type) {
  const guild = member?.guild;
  if (!guild?.id) return null;
  return {
    guildId: String(guild.id),
    userId: String(member.id ?? member.user?.id ?? 'unknown'),
    userLabel: displayLabel(member),
    type,
    channelId: null,
    timestamp: type === 'member_join' ? member.joinedAt ?? new Date() : new Date()
  };
}

async function storeAndDeliverGeneral(guild, event) {
  if (!event) return;
  logGeneralEvent(event);
  await deliverLogEvent(guild, event.type, event);
}

async function handleMemberJoin(member) {
  await storeAndDeliverGeneral(member?.guild, memberEvent(member, 'member_join'));
}

async function handleMemberLeave(member) {
  await storeAndDeliverGeneral(member?.guild, memberEvent(member, 'member_leave'));
}

async function handleVoiceStateUpdate(oldState, newState) {
  const oldChannelId = oldState?.channelId ?? oldState?.channel?.id ?? null;
  const newChannelId = newState?.channelId ?? newState?.channel?.id ?? null;
  if (oldChannelId === newChannelId) return;

  const state = newState ?? oldState;
  const guild = newState?.guild ?? oldState?.guild;
  if (!guild?.id) return;
  const member = newState?.member ?? oldState?.member;
  const base = {
    guildId: String(guild.id),
    userId: String(state?.id ?? member?.id ?? member?.user?.id ?? 'unknown'),
    userLabel: displayLabel(member),
    timestamp: new Date()
  };
  const events = [];

  if (oldChannelId) {
    events.push({
      ...base,
      type: 'voice_leave',
      channelId: String(oldChannelId)
    });
  }
  if (newChannelId) {
    events.push({
      ...base,
      type: 'voice_join',
      channelId: String(newChannelId)
    });
  }
  for (const event of events) logGeneralEvent(event);
  await Promise.all(events.map(event => deliverLogEvent(guild, event.type, event)));
}

function truncate(value, maximum, fallback = 'Unavailable') {
  const text = String(value ?? '').trim() || fallback;
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function formatAttachments(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return 'None';
  const visible = urls.slice(0, 3).map(url => truncate(url, 180)).join('\n');
  return truncate(urls.length > 3 ? `${visible}\n…and ${urls.length - 3} more` : visible, 700);
}

function addField(embed, name, value, inline = false) {
  embed.addFields({ name: truncate(name, 256), value: truncate(value, 900), inline });
}

function buildDeliveryEmbed(eventType, event, color) {
  const userId = event.userId ?? event.authorId;
  const details = [];
  if (userId) details.push(`User: <@${truncate(userId, 64)}>`);
  if (event.channelId) details.push(`Source: <#${truncate(event.channelId, 64)}>`);
  if (event.messageId) details.push(`Message: ${truncate(event.messageId, 80)}`);
  const embed = new EmbedBuilder()
    .setTitle(eventTitles[eventType])
    .setColor(Number.parseInt(color.slice(1), 16))
    .setDescription(truncate(details.join('\n'), 1000, 'Event recorded'))
    .setTimestamp(validDate(event.timestamp ?? event.occurredAt));

  if (eventType === 'command_execution') {
    addField(embed, 'Command', `${event.interactionType === 'slash' ? '/' : ''}${event.commandName ?? 'unknown'}`, true);
    addField(embed, 'Result', event.success ? 'Success' : `Failed${event.errorCode ? `: ${event.errorCode}` : ''}`, true);
  } else if (eventType === 'message_edit') {
    addField(embed, 'Before', event.beforeContent);
    addField(embed, 'After', event.afterContent);
    addField(embed, 'Attachments Before', formatAttachments(event.beforeAttachmentUrls));
    addField(embed, 'Attachments After', formatAttachments(event.afterAttachmentUrls));
  } else if (eventType === 'message_delete') {
    addField(embed, 'Deleted Content', event.beforeContent);
    addField(embed, 'Attachments', formatAttachments(event.beforeAttachmentUrls));
  } else if (event.userLabel) {
    addField(embed, 'Display Name', event.userLabel, true);
  }
  return embed;
}

async function deliverLogEvent(guild, eventType, event) {
  try {
    const configKey = deliveryConfigKeys[eventType];
    if (!configKey) return false;
    const logging = readLoggingConfig();
    if (!logging.delivery[configKey]) return false;
    if (!guild?.channels) {
      console.warn(`Could not deliver ${eventType} log event: guild channels are unavailable.`);
      return false;
    }

    let channel = guild.channels.cache?.get?.(logging.channelId);
    if (!channel && typeof guild.channels.fetch === 'function') {
      channel = await guild.channels.fetch(logging.channelId);
    }
    if (!channel) {
      console.warn(`Could not deliver ${eventType} log event: channel ${logging.channelId} could not be resolved.`);
      return false;
    }
    if (typeof channel.isTextBased !== 'function'
      || !channel.isTextBased()
      || (typeof channel.isSendable === 'function' && !channel.isSendable())
      || typeof channel.send !== 'function') {
      console.warn(`Could not deliver ${eventType} log event: channel ${logging.channelId} is not a sendable text channel.`);
      return false;
    }

    await channel.send({
      embeds: [buildDeliveryEmbed(eventType, event ?? {}, logging.colors[configKey])]
    });
    return true;
  } catch (error) {
    console.error(`Could not deliver ${eventType} log event:`, error);
    return false;
  }
}

function runRetentionCleanup(now) {
  const { retentionDays } = readLoggingConfig();
  return purgeExpiredEvents(retentionDays, now);
}

function startRetentionScheduler() {
  const timer = setInterval(() => {
    try {
      runRetentionCleanup();
    } catch (error) {
      console.error('Could not run log retention cleanup:', error);
    }
  }, 24 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  deliverLogEvent,
  handleMemberJoin,
  handleMemberLeave,
  handleMessageDelete,
  handleMessageUpdate,
  handleVoiceStateUpdate,
  runRetentionCleanup,
  snapshotMessage,
  startRetentionScheduler
};
