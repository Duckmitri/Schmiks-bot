const { readLinks, readReactionCommands, readRoleIds } = require('./config');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } = require('discord.js');
const {
  logCommandEvent,
  readCommandEventsPage,
  readMessageEventsPage,
  readGeneralEventsPage
} = require('./database');
const { deliverLogEvent } = require('./event-logging');

// Define command sets
const publicCommands = ['links'];
const moderatorCommands = ['server-info', 'kick'];
const adminCommands = ['logs'];
const linkPlatforms = ['YouTube', 'Twitch', 'TikTok', 'Instagram'];
const logsPageSize = 10;
const logViewBuilders = {};
// ponytail: grows with successful link clicks; move to expiring/persistent storage if traffic makes that material.
const usedLinkMessages = new Set();

function memberHasAnyRole(member, roleIds) {
  return roleIds.some(id => Array.isArray(member.roles)
    ? member.roles.includes(id)
    : member.roles.cache.has(id));
}

function auditInteraction(subject, interactionType, commandName, startedAt, result) {
  const user = interactionType === 'prefix' ? subject.author : subject.user;
  try {
    const event = {
      guildId: subject.guildId ?? subject.guild.id,
      channelId: subject.channelId,
      userId: user.id,
      interactionType,
      commandName,
      success: result.success,
      durationMs: Date.now() - startedAt,
      errorCode: result.errorCode
    };
    logCommandEvent(event);
    Promise.resolve(deliverLogEvent(subject.guild, 'command_execution', event))
      .catch(error => console.error('Could not deliver command audit event:', error));
  } catch (error) {
    console.error('Could not write command audit event:', error);
  }
}

function truncateText(value, maximumLength) {
  const text = String(value ?? '');
  return text.length <= maximumLength ? text : `${text.slice(0, maximumLength - 1)}…`;
}

function escapeUntrustedMarkdown(value, maximumLength) {
  const escaped = String(value ?? '').replace(/([\\`*_~{}[\]()#+!|>])/g, '\\$1');
  return truncateText(escaped || '(empty)', maximumLength);
}

function discordTimestamp(value) {
  const normalized = String(value).replace(' ', 'T');
  const timestamp = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function safeId(value) {
  return String(value ?? '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32) || 'unknown';
}

function attachmentUrls(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeAttachmentUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
    return href.length <= 200 ? href : null;
  } catch {
    return null;
  }
}

function prepareAttachments(rawUrls) {
  const raw = attachmentUrls(rawUrls);
  return { total: raw.length, urls: raw.map(safeAttachmentUrl).filter(Boolean) };
}

function formatAttachmentLine(label, attachments, shownCount) {
  const omitted = attachments.total - shownCount;
  const parts = [];
  if (omitted > 0) {
    parts.push(`${omitted} attachment${omitted === 1 ? '' : 's'} omitted`);
  }
  if (shownCount > 0) {
    parts.push(attachments.urls.slice(0, shownCount)
      .map((url, index) => `[Attachment ${index + 1}](${url})`).join(', '));
  }
  return `${label}: ${parts.join(' • ')}`;
}

function renderMessageEvent(event) {
  const author = `<@${safeId(event.author_id)}>`;
  const channel = `<#${safeId(event.channel_id)}>`;
  const when = discordTimestamp(event.occurred_at);
  const deleted = event.event_type === 'message_delete';
  const lines = deleted
    ? [
        `**Message Deleted** • ${author} • ${channel} • ${when}`,
        `Deleted: ${escapeUntrustedMarkdown(event.before_content, 80)}`
      ]
    : [
        `**Message Edited** • ${author} • ${channel} • ${when}`,
        `Before: ${escapeUntrustedMarkdown(event.before_content, 40)}`,
        `After: ${escapeUntrustedMarkdown(event.after_content, 40)}`
      ];
  const sections = deleted
    ? [{ label: 'Attachments', attachments: prepareAttachments(event.before_attachment_urls_json), shown: 0 }]
    : [
        { label: 'Before attachments', attachments: prepareAttachments(event.before_attachment_urls_json), shown: 0 },
        { label: 'After attachments', attachments: prepareAttachments(event.after_attachment_urls_json), shown: 0 }
      ];
  const populatedSections = sections.filter(section => section.attachments.total > 0);
  const assemble = () => [
    ...lines,
    ...populatedSections.map(section => formatAttachmentLine(section.label, section.attachments, section.shown))
  ].join('\n');

  for (let attachmentIndex = 0; attachmentIndex < 3; attachmentIndex += 1) {
    for (const section of populatedSections) {
      if (attachmentIndex >= section.attachments.urls.length) continue;
      section.shown += 1;
      if (assemble().length > 390) section.shown -= 1;
    }
  }

  return assemble();
}

function buildLogComponents(category, page, pageCount, throughId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`logs:${category}:${page - 1}:${throughId}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`logs:${category}:${page + 1}:${throughId}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1)
  )];
}

function buildLogsEmbed(title, emptyDescription, pageData, renderEvent, itemName) {
  const description = pageData.events.length === 0
    ? emptyDescription
    : pageData.events.map(renderEvent).join('\n\n');
  const countLabel = pageData.total === 1 ? itemName : `${itemName}s`;
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: `Page ${pageData.page + 1} of ${pageData.pageCount} • ${pageData.total} ${countLabel}` })
    .setTimestamp();
}

function buildCommandLogsView(guildId, requestedPage = 0, requestedThroughId) {
  const { events, total, page, pageCount, throughId } = readCommandEventsPage(
    guildId,
    requestedPage,
    logsPageSize,
    requestedThroughId
  );
  const description = events.length === 0
    ? 'No command logs have been recorded for this server yet.'
    : events.map(event => {
      const commandName = escapeMarkdown(String(event.command_name)).slice(0, 80);
      const command = event.interaction_type === 'slash' ? `/${commandName}` : commandName;
      const errorCode = event.error_code
        ? escapeMarkdown(String(event.error_code)).slice(0, 80)
        : 'Failed';
      const outcome = event.success ? '✅ Success' : `❌ ${errorCode}`;
      const timestamp = Math.floor(Date.parse(`${event.occurred_at.replace(' ', 'T')}Z`) / 1000);
      const userId = String(event.user_id).slice(0, 32);
      const channel = event.channel_id ? `<#${String(event.channel_id).slice(0, 32)}>` : 'Unknown channel';
      const duration = Number.isInteger(event.duration_ms) ? `${event.duration_ms} ms` : 'No duration';
      return `**${command}** • ${event.interaction_type} • ${outcome}\n<t:${timestamp}:R> • <@${userId}> • ${channel} • ${duration}`;
    }).join('\n\n');
  const commandLabel = total === 1 ? 'command' : 'commands';
  const embed = new EmbedBuilder()
    .setTitle('Command Logs')
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: `Page ${page + 1} of ${pageCount} • ${total} ${commandLabel}` })
    .setTimestamp();
  const components = buildLogComponents('commands', page, pageCount, throughId);

  return { embeds: [embed], components };
}

function buildMessageLogsView(guildId, requestedPage = 0, requestedThroughId) {
  const pageData = readMessageEventsPage(guildId, requestedPage, logsPageSize, requestedThroughId);
  const embed = buildLogsEmbed(
    'Message Logs',
    'No message logs have been recorded for this server yet.',
    pageData,
    renderMessageEvent,
    'event'
  );
  return {
    embeds: [embed],
    components: buildLogComponents('messages', pageData.page, pageData.pageCount, pageData.throughId)
  };
}

function buildGeneralLogsView(guildId, requestedPage = 0, requestedThroughId) {
  const pageData = readGeneralEventsPage(guildId, requestedPage, logsPageSize, requestedThroughId);
  const eventNames = {
    member_join: 'Member Joined',
    member_leave: 'Member Left',
    voice_join: 'Voice Joined',
    voice_leave: 'Voice Left'
  };
  const embed = buildLogsEmbed(
    'General Logs',
    'No general logs have been recorded for this server yet.',
    pageData,
    event => {
      const user = `<@${safeId(event.user_id)}>`;
      const label = event.user_label ? ` • ${escapeUntrustedMarkdown(event.user_label, 120)}` : '';
      const channel = event.channel_id ? ` • <#${safeId(event.channel_id)}>` : '';
      return `**${eventNames[event.event_type] ?? 'General Event'}** • ${user}${label}${channel} • ${discordTimestamp(event.occurred_at)}`;
    },
    'event'
  );
  return {
    embeds: [embed],
    components: buildLogComponents('general', pageData.page, pageData.pageCount, pageData.throughId)
  };
}

Object.assign(logViewBuilders, {
  commands: buildCommandLogsView,
  messages: buildMessageLogsView,
  general: buildGeneralLogsView
});

function logCategoryLabel(category) {
  return category === 'commands' ? 'command' : category === 'messages' ? 'message' : 'general';
}

async function executeKick({ guild, target, reason }) {
  if (!target?.kickable) return { success: false, errorCode: 'TARGET_NOT_KICKABLE' };

  const boundedReason = String(reason).slice(0, 512);
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(`You have been kicked from ${guild.name}`)
    .setDescription(boundedReason);
  let dmDelivered = true;
  try {
    await target.send({ embeds: [embed] });
  } catch {
    dmDelivered = false;
  }
  await target.kick(boundedReason);
  return { success: true, dmDelivered };
}

async function handleMessageReactionAdd(reaction, user) {
  if (user.bot) return false;
  if (reaction.partial) reaction = await reaction.fetch();

  const commandName = readReactionCommands()[reaction.emoji.id ?? reaction.emoji.name];
  if (commandName !== 'kick') return false;

  let message = reaction.message;
  if (message.partial) message = await message.fetch();
  const guild = message.guild;
  if (!guild || !message.author) return false;

  const startedAt = Date.now();
  const auditContext = {
    user,
    guild,
    guildId: message.guildId ?? guild.id,
    channelId: message.channelId
  };

  try {
    const reactor = await guild.members.fetch(user.id);
    if (reactor.user.bot) return false;
    const { moderatorRoleIds, adminRoleIds } = readRoleIds();
    if (!memberHasAnyRole(reactor, [...moderatorRoleIds, ...adminRoleIds])) return false;

    const target = await guild.members.fetch(message.author.id);
    const reason = message.content.trim() || 'You have been kicked from the server, no reason provided';
    const result = await executeKick({ guild, target, reason });
    auditInteraction(auditContext, 'reaction', 'kick', startedAt, result);
    try {
      await message.reply(result.success
        ? result.dmDelivered
          ? 'The member was kicked.'
          : 'The member was kicked, but their DM notification failed.'
        : 'That member cannot be kicked.');
    } catch (error) {
      console.error('Could not reply to reaction kick command:', error);
    }
    return true;
  } catch (error) {
    console.error('Error in reaction kick command:', error);
    auditInteraction(auditContext, 'reaction', 'kick', startedAt, {
      success: false,
      errorCode: 'EXECUTION_FAILED'
    });
    try {
      await message.reply('An error occurred while executing the kick command.');
    } catch (replyError) {
      console.error('Could not reply to reaction kick command:', replyError);
    }
    return true;
  }
}

// Command implementations
const commandHandlers = {
  'server-info': async (messageOrInteraction, argsOrOptions, isSlash) => {
    try {
      // Determine guild and reply method
      let guild;
      let user;
      if (isSlash) {
        guild = messageOrInteraction.guild;
        user = messageOrInteraction.user;
        if (!guild) {
          await messageOrInteraction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
          return { success: false, errorCode: 'INVALID_CONTEXT' };
        }
      } else {
        guild = messageOrInteraction.guild;
        user = messageOrInteraction.author;
        if (!guild) {
          await messageOrInteraction.reply('This command can only be used in a server.');
          return { success: false, errorCode: 'INVALID_CONTEXT' };
        }
      }

      // Gather server data
      const totalMembers = guild.memberCount;
      const botCount = guild.members.cache.filter(m => m.user.bot).size;
      const humanCount = totalMembers - botCount;
      const owner = `<@${guild.ownerId}>`;
      const createdAt = guild.createdAt.toLocaleString();
      const verificationLevel = String(guild.verificationLevel);

      // Build embed
      const embed = new EmbedBuilder()
        .setTitle(`${guild.name} Server Info`)
        .setColor(0x0099ff)
        .setDescription('This server was created at ' + createdAt)
        .addFields(
          { name: 'Owner', value: owner, inline: true },
          { name: 'Total Members', value: totalMembers.toString(), inline: true },
          { name: 'Humans', value: humanCount.toString(), inline: true },
          { name: 'Bots', value: botCount.toString(), inline: true },
          { name: 'Verification Level', value: verificationLevel, inline: true },
        )
        .setTimestamp()
        .setFooter({ text: `Requested by ${user.tag}` });

      const iconUrl = guild.iconURL({ size: 256 });
      if (iconUrl) embed.setThumbnail(iconUrl);

      // Send reply
      await messageOrInteraction.reply({ embeds: [embed]});
      return { success: true };
    } catch (error) {
      console.error('Error in server-info command:', error);
      await messageOrInteraction.reply({ content: 'An error occurred while executing the command.', ephemeral: true });
      return { success: false, errorCode: 'EXECUTION_FAILED' };
    }
  },

  'links': async (messageOrInteraction, argsOrOptions, isSlash) => {
    try {
      const links = readLinks();
      const configuredNames = new Set(links.map(link => link.name.toLowerCase()));
      const row = new ActionRowBuilder().addComponents(
        linkPlatforms.map(name => new ButtonBuilder()
          .setCustomId(`link:${name.toLowerCase()}`)
          .setLabel(name)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!configuredNames.has(name.toLowerCase())))
      );

      await messageOrInteraction.reply({
        content: 'Which link would you like?',
        components: [row]
      });
      return { success: true };
    } catch (error) {
      console.error('Error in links command:', error);
      await messageOrInteraction.reply({ content: 'An error occurred while executing the command.' });
      return { success: false, errorCode: 'EXECUTION_FAILED' };
    }
  },

  'kick': async (messageOrInteraction, argsOrOptions, isSlash) => {
    try {
      const selectedTarget = isSlash
        ? messageOrInteraction.options.getMember('target')
        : messageOrInteraction.mentions.members.first();
      const target = isSlash && selectedTarget && !('kickable' in selectedTarget)
        ? await messageOrInteraction.guild.members.fetch(selectedTarget.id ?? selectedTarget.user?.id)
        : selectedTarget;
      const reason = isSlash
        ? messageOrInteraction.options.getString('reason', true)
        : argsOrOptions.slice(1).join(' ').trim();

      if (!target || !reason) {
        const invokedCommand = isSlash
          ? '/kick'
          : messageOrInteraction.content.trim().split(/\s+/)[0];
        await messageOrInteraction.reply(`Usage: ${invokedCommand} @member <reason>`);
        return { success: false, errorCode: 'INVALID_OPTION' };
      }

      const result = await executeKick({ guild: messageOrInteraction.guild, target, reason });
      const reply = result.success
        ? result.dmDelivered
          ? 'The member was kicked.'
          : 'The member was kicked, but their DM notification failed.'
        : 'That member cannot be kicked.';
      try {
        await messageOrInteraction.reply(reply);
      } catch (error) {
        console.error('Could not reply to kick command:', error);
      }
      return result;
    } catch (error) {
      console.error('Error in kick command:', error);
      const errorReply = { content: 'An error occurred while executing the kick command.' };
      if (isSlash) errorReply.ephemeral = true;
      await messageOrInteraction.reply(errorReply);
      return { success: false, errorCode: 'EXECUTION_FAILED' };
    }
  },

  'logs': async (messageOrInteraction, argsOrOptions, isSlash) => {
    let logType;
    try {
      logType = isSlash
        ? messageOrInteraction.options.getString('type', true)
        : argsOrOptions[0]?.toLowerCase();

      if (!['general', 'messages', 'commands'].includes(logType)) {
        const invokedCommand = isSlash
          ? '/logs'
          : messageOrInteraction.content.trim().split(/\s+/)[0];
        await messageOrInteraction.reply(`Usage: ${invokedCommand} <general|messages|commands>`);
        return { success: false, errorCode: 'INVALID_OPTION' };
      }

      await messageOrInteraction.reply(logViewBuilders[logType](messageOrInteraction.guild.id));
      return { success: true };
    } catch (error) {
      console.error('Error in logs command:', error);
      const errorReply = { content: `Could not load ${logCategoryLabel(logType)} logs.` };
      if (isSlash) errorReply.ephemeral = true;
      await messageOrInteraction.reply(errorReply);
      return { success: false, errorCode: 'EXECUTION_FAILED' };
    }
  }
};

/**
 * Handle a prefix command
 * @param {import('discord.js').Message} message - The message object
 * @param {string} prefix - The bot's prefix
 */
async function handlePrefixCommand(message, prefix) {
  const startedAt = Date.now();
  // Extract command and args
  const content = message.content.slice(prefix.length).trim();
  if (!content) return;

  const parts = content.split(/\s+/);
  const commandName = parts.shift()?.toLowerCase();
  const args = parts;

  if (!commandName) return;

  // Public command handling
  if (publicCommands.includes(commandName)) {
    const result = await commandHandlers[commandName](message, args, false);
    auditInteraction(message, 'prefix', commandName, startedAt, result);
    return;
  }

  // Load role IDs from config
  const { moderatorRoleIds, adminRoleIds } = readRoleIds();

  // Moderator command handling
  if ((moderatorRoleIds.length > 0 || adminRoleIds.length > 0) && moderatorCommands.includes(commandName)) {
    if (memberHasAnyRole(message.member, [...moderatorRoleIds, ...adminRoleIds])) {
      // Execute moderator command via handler
      const result = await commandHandlers[commandName](message, args, false);
      auditInteraction(message, 'prefix', commandName, startedAt, result);
      return;
    } else {
      await message.reply('You do not have permission to use moderator commands.');
      auditInteraction(message, 'prefix', commandName, startedAt, {
        success: false,
        errorCode: 'PERMISSION_DENIED'
      });
      return;
    }
  }

  // Administrator command handling
  if (adminRoleIds.length > 0 && adminCommands.includes(commandName)) {
    if (memberHasAnyRole(message.member, adminRoleIds)) {
      // Execute admin command via handler
      const result = await commandHandlers[commandName](message, args, false);
      auditInteraction(message, 'prefix', commandName, startedAt, result);
      return;
    } else {
      await message.reply('You do not have permission to use administrator commands.');
      auditInteraction(message, 'prefix', commandName, startedAt, {
        success: false,
        errorCode: 'PERMISSION_DENIED'
      });
      return;
    }
  }

  // General command handling (do nothing for unknown commands)
  auditInteraction(message, 'prefix', commandName, startedAt, {
    success: false,
    errorCode: 'UNKNOWN_COMMAND'
  });
  return;
}

/**
 * Handle a slash command interaction
 * @param {import('discord.js').CommandInteraction} interaction - The interaction object
 */
async function handleSlashCommand(interaction) {
  const startedAt = Date.now();
  const commandName = interaction.commandName;

  // Load role IDs from config
  const { moderatorRoleIds, adminRoleIds } = readRoleIds();

  // Ensure interaction is in a guild and we have member info
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
    return;
  }

  // Public command handling
  if (publicCommands.includes(commandName)) {
    const result = await commandHandlers[commandName](interaction, [], true);
    auditInteraction(interaction, 'slash', commandName, startedAt, result);
    return;
  }

  // Moderator command handling
  if ((moderatorRoleIds.length > 0 || adminRoleIds.length > 0) && moderatorCommands.includes(commandName)) {
    if (memberHasAnyRole(interaction.member, [...moderatorRoleIds, ...adminRoleIds])) {
      // Execute moderator command via handler
      const result = await commandHandlers[commandName](interaction, [], true);
      auditInteraction(interaction, 'slash', commandName, startedAt, result);
      return;
    } else {
      await interaction.reply({
        content: 'You do not have permission to use moderator commands.',
        ephemeral: true
      });
      auditInteraction(interaction, 'slash', commandName, startedAt, {
        success: false,
        errorCode: 'PERMISSION_DENIED'
      });
      return;
    }
  }

  // Administrator command handling
  if (adminRoleIds.length > 0 && adminCommands.includes(commandName)) {
    if (memberHasAnyRole(interaction.member, adminRoleIds)) {
      // Execute admin command via handler
      const result = await commandHandlers[commandName](interaction, [], true);
      auditInteraction(interaction, 'slash', commandName, startedAt, result);
      return;
    } else {
      await interaction.reply({
        content: 'You do not have permission to use administrator commands.',
        ephemeral: true
      });
      auditInteraction(interaction, 'slash', commandName, startedAt, {
        success: false,
        errorCode: 'PERMISSION_DENIED'
      });
      return;
    }
  }

  // If command not found or no permission, reply with error
  await interaction.reply({
    content: 'Unknown command or insufficient permissions.',
    ephemeral: true
  });
  auditInteraction(interaction, 'slash', commandName, startedAt, {
    success: false,
    errorCode: 'UNKNOWN_COMMAND'
  });
}

/**
 * Handle link button interactions.
 * @param {import('discord.js').ButtonInteraction} interaction - The button interaction
 */
async function handleButtonInteraction(interaction) {
  const startedAt = Date.now();
  const logsPage = /^logs:(commands|messages|general):(\d+):(\d+)$/.exec(interaction.customId);

  if (logsPage) {
    const category = logsPage[1];
    try {
      const { adminRoleIds } = readRoleIds();
      if (adminRoleIds.length === 0 || !memberHasAnyRole(interaction.member, adminRoleIds)) {
        await interaction.reply({
          content: 'You do not have permission to view administrator logs.',
          ephemeral: true
        });
        auditInteraction(interaction, 'button', interaction.customId, startedAt, {
          success: false,
          errorCode: 'PERMISSION_DENIED'
        });
        return true;
      }

      const page = Number.parseInt(logsPage[2], 10);
      const throughId = Number.parseInt(logsPage[3], 10);
      await interaction.update(logViewBuilders[category](interaction.guildId, page, throughId));
      auditInteraction(interaction, 'button', interaction.customId, startedAt, { success: true });
      return true;
    } catch (error) {
      console.error(`Error changing ${category} log page:`, error);
      await interaction.reply({
        content: `Could not load ${logCategoryLabel(category)} logs.`,
        ephemeral: true
      });
      auditInteraction(interaction, 'button', interaction.customId, startedAt, {
        success: false,
        errorCode: 'EXECUTION_FAILED'
      });
      return true;
    }
  }

  if (!interaction.customId.startsWith('link:')) return false;

  try {
    const platform = interaction.customId.slice('link:'.length);
    const link = readLinks().find(item => item.name.toLowerCase() === platform);

    if (!link) {
      await interaction.reply({ content: 'That link is not currently configured.' });
      auditInteraction(interaction, 'button', interaction.customId, startedAt, {
        success: false,
        errorCode: 'LINK_NOT_CONFIGURED'
      });
      return true;
    }

    const useKey = interaction.message?.id && `${interaction.message.id}:${interaction.user.id}`;
    if (useKey && usedLinkMessages.has(useKey)) {
      await interaction.reply({
        content: 'You have already opened a link from this message.',
        ephemeral: true
      });
      return true;
    }
    if (useKey) usedLinkMessages.add(useKey);

    const embed = new EmbedBuilder()
      .setTitle(link.name)
      .setColor(0x0099ff)
      .setDescription(`[Click here](${link.url})`);

    if (typeof link.iconUrl === 'string' && link.iconUrl.trim()) {
      embed.setThumbnail(link.iconUrl);
    }

    await interaction.reply({ embeds: [embed] });
    auditInteraction(interaction, 'button', interaction.customId, startedAt, {
      success: true
    });
    return true;
  } catch (error) {
    console.error('Error handling link button:', error);
    await interaction.reply({ content: 'An error occurred while opening that link.' });
    auditInteraction(interaction, 'button', interaction.customId, startedAt, {
      success: false,
      errorCode: 'EXECUTION_FAILED'
    });
    return true;
  }
}

module.exports = {
  buildCommandLogsView,
  buildMessageLogsView,
  buildGeneralLogsView,
  executeKick,
  handleButtonInteraction,
  handleMessageReactionAdd,
  handlePrefixCommand,
  handleSlashCommand
};
