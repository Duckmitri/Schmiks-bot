const fs = require('node:fs');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');

const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config', 'config.json');
const deliveryKeys = [
  'commandExecution',
  'messageEdit',
  'messageDelete',
  'memberJoin',
  'memberLeave',
  'voiceJoin',
  'voiceLeave'
];
const defaultLogColors = Object.freeze({
  commandExecution: '#5865F2',
  messageEdit: '#FEE75C',
  messageDelete: '#ED4245',
  memberJoin: '#57F287',
  memberLeave: '#ED4245',
  voiceJoin: '#57F287',
  voiceLeave: '#ED4245'
});
const defaultWarningEmbed = Object.freeze({
  color: '#FEE75C',
  title: 'Warning from {server}',
  message: '{reason}\n\nModerator: {moderator}'
});
const defaultKickEmbed = Object.freeze({
  color: '#ED4245',
  title: 'Kicked from {server}',
  message: '{reason}\n\nModerator: {moderator}'
});
const defaultBanEmbed = Object.freeze({
  color: '#ED4245',
  title: 'Banned from {server}',
  message: '{reason}\n\nModerator: {moderator}'
});

const defaultMuteEmbed = Object.freeze({
  color: '#ED4245',
  title: 'Muted from {server}',
  message: '{reason}\n\nModerator: {moderator}'
});

const defaultAutoRole = Object.freeze(''); // Empty string means no auto-role

const defaultModeratorCommandPermissions = Object.freeze([
  'warn', 'kick', 'mute'  // Moderators can use warning, kick, and mute commands
]);
const defaultAdminCommandPermissions = Object.freeze([
  'kick', 'ban', 'mute', 'warn', 'infractions', 'logs', 'addrole', 'removerole', 'setnick', 'audit'  // Admins can use all commands
]);

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.trim() || prefix.length > 5) {
    throw new TypeError('Prefix must be a non-empty string of at most 5 characters');
  }
  return prefix;
}

function readPrefix() {
  if (process.env.BOT_PREFIX) return validatePrefix(process.env.BOT_PREFIX);

  const prefix = readConfig().prefix;
  return prefix === undefined ? '!' : validatePrefix(prefix);
}

function writePrefix(prefix) {
  const value = validatePrefix(prefix);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ ...readConfig(), prefix: value }, null, 2)}\n`);
  return value;
}

function validateLoggingConfig(value) {
  const logging = value && typeof value === 'object' ? value : {};
  const channelId = logging.channelId === undefined ? '' : logging.channelId;
  const retentionDays = logging.retentionDays === undefined ? 90 : logging.retentionDays;
  const deliverySource = logging.delivery && typeof logging.delivery === 'object' ? logging.delivery : {};
  const colorSource = logging.colors && typeof logging.colors === 'object' ? logging.colors : {};

  if (typeof channelId !== 'string' || !/^(?:|\d{17,20})$/.test(channelId)) {
    throw new TypeError('Logging channel ID must be empty or contain 17 to 20 digits');
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new TypeError('Logging retention days must be a whole number from 1 through 3650');
  }

  const delivery = Object.fromEntries(deliveryKeys.map(key => [key, deliverySource[key] === true]));
  const colors = Object.fromEntries(deliveryKeys.map(key => {
    const color = colorSource[key] === undefined ? defaultLogColors[key] : colorSource[key];
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new TypeError(`Logging color for ${key} must use #RRGGBB format`);
    }
    return [key, color.toUpperCase()];
  }));
  if (!channelId && Object.values(delivery).some(Boolean)) {
    throw new TypeError('Logging channel ID is required when delivery is enabled');
  }

  return { channelId, retentionDays, colors, delivery };
}

function readLoggingConfig() {
  return validateLoggingConfig(readConfig().logging);
}

function validateWarningEmbedConfig(value) {
  const warningEmbed = value && typeof value === 'object' ? value : defaultWarningEmbed;
  const color = warningEmbed.color === undefined ? defaultWarningEmbed.color : warningEmbed.color;
  const title = warningEmbed.title === undefined ? defaultWarningEmbed.title : warningEmbed.title;
  const message = warningEmbed.message === undefined ? defaultWarningEmbed.message : warningEmbed.message;

  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new TypeError('Warning embed color must use #RRGGBB format');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new TypeError('Warning embed title must be a nonblank string');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('Warning embed message must be a nonblank string');
  }

  return {
    color: color.toUpperCase(),
    title: title.trim().slice(0, 256),
    message: message.trim().slice(0, 4096)
  };
}

function validateKickEmbedConfig(value) {
  const kickEmbed = value && typeof value === 'object' ? value : defaultKickEmbed;
  const color = kickEmbed.color === undefined ? defaultKickEmbed.color : kickEmbed.color;
  const title = kickEmbed.title === undefined ? defaultKickEmbed.title : kickEmbed.title;
  const message = kickEmbed.message === undefined ? defaultKickEmbed.message : kickEmbed.message;

  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new TypeError('Kick embed color must use #RRGGBB format');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new TypeError('Kick embed title must be a nonblank string');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('Kick embed message must be a nonblank string');
  }

  return {
    color: color.toUpperCase(),
    title: title.trim().slice(0, 256),
    message: message.trim().slice(0, 4096)
  };
}

function validateBanEmbedConfig(value) {
  const banEmbed = value && typeof value === 'object' ? value : defaultBanEmbed;
  const color = banEmbed.color === undefined ? defaultBanEmbed.color : banEmbed.color;
  const title = banEmbed.title === undefined ? defaultBanEmbed.title : banEmbed.title;
  const message = banEmbed.message === undefined ? defaultBanEmbed.message : banEmbed.message;

  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new TypeError('Ban embed color must use #RRGGBB format');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new TypeError('Ban embed title must be a nonblank string');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('Ban embed message must be a nonblank string');
  }

  return {
    color: color.toUpperCase(),
    title: title.trim().slice(0, 256),
    message: message.trim().slice(0, 4096)
  };
}

function readWarningEmbedConfig() {
  return validateWarningEmbedConfig(readConfig().warningEmbed);
}

function readKickEmbedConfig() {
  return validateKickEmbedConfig(readConfig().kickEmbed);
}

function readBanEmbedConfig() {
  return validateBanEmbedConfig(readConfig().banEmbed);
}

function validateMuteEmbedConfig(value) {
  const muteEmbed = value && typeof value === 'object' ? value : defaultMuteEmbed;
  const color = muteEmbed.color === undefined ? defaultMuteEmbed.color : muteEmbed.color;
  const title = muteEmbed.title === undefined ? defaultMuteEmbed.title : muteEmbed.title;
  const message = muteEmbed.message === undefined ? defaultMuteEmbed.message : muteEmbed.message;

  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new TypeError('Mute embed color must use #RRGGBB format');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new TypeError('Mute embed title must be a nonblank string');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('Mute embed message must be a nonblank string');
  }

  return {
    color: color.toUpperCase(),
    title: title.trim().slice(0, 256),
    message: message.trim().slice(0, 4096)
  };
}

function readMuteEmbedConfig() {
  return validateMuteEmbedConfig(readConfig().muteEmbed);
}

function validateCommandPermissions(permissions) {
  if (!Array.isArray(permissions)) throw new TypeError('Command permissions must be an array');

  const validCommands = ['kick', 'ban', 'mute', 'warn', 'infractions', 'logs', 'addrole', 'removerole', 'setnick', 'audit'];

  const normalized = [...new Set(permissions.map(cmd => typeof cmd === 'string' ? cmd.trim().toLowerCase() : cmd))];

  if (normalized.some(cmd => typeof cmd !== 'string' || !validCommands.includes(cmd))) {
    throw new TypeError(`Each command must be one of: ${validCommands.join(', ')}`);
  }

  return normalized;
}

function readModeratorCommandPermissions() {
  const moderatorCommandPermissions = readConfig().moderatorCommandPermissions;
  return validateCommandPermissions(Array.isArray(moderatorCommandPermissions) ? moderatorCommandPermissions : defaultModeratorCommandPermissions);
}

function readAdminCommandPermissions() {
  const adminCommandPermissions = readConfig().adminCommandPermissions;
  return validateCommandPermissions(Array.isArray(adminCommandPermissions) ? adminCommandPermissions : defaultAdminCommandPermissions);
}

function validateAutoRole(role) {
  // Auto-role can be empty string (disabled) or a valid role ID
  if (typeof role !== 'string') {
    throw new TypeError('Auto-role must be a string');
  }

  // If not empty, validate it's a proper role ID
  if (role.trim() !== '' && !/^\d{17,20}$/.test(role.trim())) {
    throw new TypeError('Auto-role ID must contain 17 to 20 digits');
  }

  return role.trim();
}

function readAutoRoleConfig() {
  const autoRole = readConfig().autoRole;
  return validateAutoRole(typeof autoRole === 'string' ? autoRole : defaultAutoRole);
}

function validateRoleIds(roleIds) {
  if (!Array.isArray(roleIds)) throw new TypeError('Role IDs must be an array');

  const normalized = [...new Set(roleIds.map(roleId => typeof roleId === 'string' ? roleId.trim() : roleId))];
  if (normalized.some(roleId => typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId))) {
    throw new TypeError('Each role ID must contain 17 to 20 digits');
  }
  return normalized;
}

function writeDashboardConfig({ prefix, moderatorRoleIds, adminRoleIds, logging, warningEmbed, kickEmbed, banEmbed, muteEmbed, moderatorCommandPermissions, adminCommandPermissions, autoRole }) {
  const saved = {
    prefix: validatePrefix(prefix),
    moderatorRoleIds: validateRoleIds(moderatorRoleIds),
    adminRoleIds: validateRoleIds(adminRoleIds),
    logging: validateLoggingConfig(logging),
    warningEmbed: validateWarningEmbedConfig(warningEmbed),
    kickEmbed: validateKickEmbedConfig(kickEmbed),
    banEmbed: validateBanEmbedConfig(banEmbed),
    muteEmbed: validateMuteEmbedConfig(muteEmbed),
    moderatorCommandPermissions: validateCommandPermissions(moderatorCommandPermissions),
    adminCommandPermissions: validateCommandPermissions(adminCommandPermissions),
    autoRole: validateAutoRole(autoRole)
  };
  const persisted = {
    ...readConfig(),
    prefix: saved.prefix,
    moderatorRoleId: saved.moderatorRoleIds,
    adminRoleId: saved.adminRoleIds,
    logging: saved.logging,
    warningEmbed: saved.warningEmbed,
    kickEmbed: saved.kickEmbed,
    banEmbed: saved.banEmbed,
    muteEmbed: saved.muteEmbed,
    moderatorCommandPermissions: saved.moderatorCommandPermissions,
    adminCommandPermissions: saved.adminCommandPermissions,
    autoRole: saved.autoRole
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);
  return saved;
}

function readRoleIds() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Handle moderatorRoleId: can be string or array
    let moderatorRoleIds = config.moderatorRoleId;
    if (typeof moderatorRoleIds === 'string') {
      moderatorRoleIds = [moderatorRoleIds];
    } else if (!Array.isArray(moderatorRoleIds)) {
      moderatorRoleIds = [];
    }
    // Handle adminRoleId similarly
    let adminRoleIds = config.adminRoleId;
    if (typeof adminRoleIds === 'string') {
      adminRoleIds = [adminRoleIds];
    } else if (!Array.isArray(adminRoleIds)) {
      adminRoleIds = [];
    }
    return {
      moderatorRoleIds,
      adminRoleIds
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { moderatorRoleIds: [], adminRoleIds: [] };
  }
}

function readLinks() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(config.links)) return [];

    return config.links.filter(link =>
      link
      && typeof link.name === 'string'
      && link.name.trim()
      && typeof link.url === 'string'
      && link.url.trim()
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

function readReactionCommands() {
  const source = readConfig().reactionCommands;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).filter(([emoji, command]) =>
    emoji.trim() && typeof command === 'string' && command.trim()
  ));
}

function readSlashCommands() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (Array.isArray(config.slashCommands)) {
      return addBuiltInSlashCommands(config.slashCommands);
    } else {
      console.error('Invalid slashCommands in config.json, using defaults');
      return addBuiltInSlashCommands(getDefaultSlashCommands());
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error reading slash commands:', error);
    }
    return addBuiltInSlashCommands(getDefaultSlashCommands());
  }
}

function addBuiltInSlashCommands(commands) {
  const kickCommand = new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member')
    .addUserOption(option => option
      .setName('target')
      .setDescription('Member to kick')
      .setRequired(true))
    .addStringOption(option => option
      .setName('reason')
      .setDescription('Reason for kicking')
      .setRequired(true));

  const banCommand = new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member')
    .addUserOption(option => option
      .setName('target')
      .setDescription('Member to ban')
      .setRequired(true))
    .addStringOption(option => option
      .setName('length')
      .setDescription('Ban length (1d, 1w, 1m, 1y)')
      .setRequired(true))
    .addStringOption(option => option
      .setName('reason')
      .setDescription('Reason for banning')
      .setRequired(true));

  const muteCommand = new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Mute a member')
    .addUserOption(option => option
      .setName('target')
      .setDescription('Member to mute')
      .setRequired(true))
    .addStringOption(option => option
      .setName('length')
      .setDescription('Mute length (1m, 1h, 1d, 1w, 1mo)')
      .setRequired(true)
      .addChoices(
        { name: '1 minute', value: '1m' },
        { name: '1 hour', value: '1h' },
        { name: '1 day', value: '1d' },
        { name: '1 week', value: '1w' },
        { name: '1 month', value: '1mo' }
      ))
    .addStringOption(option => option
      .setName('reason')
      .setDescription('Reason for muting')
      .setRequired(true));

  const logsCommand = new SlashCommandBuilder()
    .setName('logs')
    .setDescription('View server logs')
    .addStringOption(option => option
      .setName('type')
      .setDescription('Choose which logs to view')
      .setRequired(true)
      .addChoices(
        { name: 'general', value: 'general' },
        { name: 'messages', value: 'messages' },
        { name: 'commands', value: 'commands' }
      ));

  const warnCommand = new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member')
    .addUserOption(option => option
      .setName('target')
      .setDescription('Member to warn')
      .setRequired(true))
    .addStringOption(option => option
      .setName('reason')
      .setDescription('Reason for warning')
      .setRequired(true));

  const infractionsCommand = new SlashCommandBuilder()
    .setName('infractions')
    .setDescription('View a member\'s infraction history')
    .addUserOption(option => option
      .setName('target')
      .setDescription('Member whose infractions to view')
      .setRequired(true));

  return [
    ...commands.filter(command => !['logs', 'kick', 'ban', 'mute', 'warn', 'infractions'].includes(command.name)),
    kickCommand.toJSON(),
    banCommand.toJSON(),
    muteCommand.toJSON(),
    warnCommand.toJSON(),
    infractionsCommand.toJSON(),
    logsCommand.toJSON()
  ];
}

function getDefaultSlashCommands() {
  return [
    { name: 'kick', description: 'Kick a member' },
    { name: 'ban', description: 'Ban a member' },
    { name: 'mute', description: 'Mute a member' },
    { name: 'warn', description: 'Warn a member' },
    { name: 'addrole', description: 'Add a role to a member' },
    { name: 'removerole', description: 'Remove a role from a member' },
    { name: 'setnick', description: 'Set a member\'s nickname' },
    { name: 'audit', description: 'Audit log' }
  ];
}

module.exports = {
  readPrefix,
  validatePrefix,
  writePrefix,
  readLoggingConfig,
  validateLoggingConfig,
  readWarningEmbedConfig,
  validateWarningEmbedConfig,
  readKickEmbedConfig,
  validateKickEmbedConfig,
  readBanEmbedConfig,
  validateBanEmbedConfig,
  readMuteEmbedConfig,
  validateMuteEmbedConfig,
  validateCommandPermissions,
  readModeratorCommandPermissions,
  readAdminCommandPermissions,
  validateRoleIds,
  writeDashboardConfig,
  readRoleIds,
  readLinks,
  readReactionCommands,
  readSlashCommands,
  readAutoRoleConfig,
  validateAutoRole
};
