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

function validateRoleIds(roleIds) {
  if (!Array.isArray(roleIds)) throw new TypeError('Role IDs must be an array');

  const normalized = [...new Set(roleIds.map(roleId => typeof roleId === 'string' ? roleId.trim() : roleId))];
  if (normalized.some(roleId => typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId))) {
    throw new TypeError('Each role ID must contain 17 to 20 digits');
  }
  return normalized;
}

function writeDashboardConfig({ prefix, moderatorRoleIds, adminRoleIds, logging }) {
  const saved = {
    prefix: validatePrefix(prefix),
    moderatorRoleIds: validateRoleIds(moderatorRoleIds),
    adminRoleIds: validateRoleIds(adminRoleIds),
    logging: validateLoggingConfig(logging)
  };
  const persisted = {
    ...readConfig(),
    prefix: saved.prefix,
    moderatorRoleId: saved.moderatorRoleIds,
    adminRoleId: saved.adminRoleIds,
    logging: saved.logging
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

  return [
    ...commands.filter(command => command.name !== 'logs' && command.name !== 'kick'),
    kickCommand.toJSON(),
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
  validateRoleIds,
  writeDashboardConfig,
  readRoleIds,
  readLinks,
  readReactionCommands,
  readSlashCommands
};
