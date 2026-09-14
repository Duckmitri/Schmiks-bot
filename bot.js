// Suppress deprecation warning for the 'ready' event rename in discord.js v15
if (process.noDeprecation === undefined) {
  process.noDeprecation = true;
}

const { Client, GatewayIntentBits, Partials, PermissionFlagsBits } = require('discord.js');
const { readPrefix, readRoleIds, readSlashCommands } = require('./config');
const { createRateLimiter } = require('./rate-limit');
const {
  handleButtonInteraction,
  handleMessageReactionAdd,
  handlePrefixCommand,
  handleSlashCommand
} = require('./commands');
const {
  handleMemberJoin,
  handleMemberLeave,
  handleMessageDelete,
  handleMessageUpdate,
  handleVoiceStateUpdate,
  runRetentionCleanup,
  snapshotMessage,
  startRetentionScheduler
} = require('./event-logging');

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is required');

const allowCommand = createRateLimiter(2_000);
const allowButton = createRateLimiter(2_000);

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
], partials: [
  Partials.Channel,
  Partials.Message,
  Partials.GuildMember,
  Partials.Reaction,
  Partials.User
] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  try {
    console.log('Log retention cleanup:', runRetentionCleanup());
  } catch (error) {
    console.error('Could not run initial log retention cleanup:', error);
  }
  startRetentionScheduler();

  // Register slash commands
  try {
    const commands = readSlashCommands();
    console.log(`Slash commands to register: ${JSON.stringify(commands)}`);
    if (commands.length === 0) {
      console.warn('No slash commands to register!');
    }
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      // Register commands to a specific guild (for instant updates)
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`Registered ${commands.length} slash commands for guild ${guildId}`);
    } else {
      // Register commands globally (takes up to an hour to update)
      await client.application.commands.set(commands);
      console.log(`Registered ${commands.length} global slash commands`);
    }
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

client.on('messageCreate', async message => {
  try {
    await snapshotMessage(message);
  } catch (error) {
    console.error('Unhandled message snapshot error:', error);
  }

  if (message.author.bot || !message.guild || !message.member) return;

  let prefix;
  try {
    prefix = readPrefix();
  } catch (error) {
    console.error('Could not read config:', error);
    return;
  }
  if (!message.content.startsWith(prefix)) return;
  if (!allowCommand(message.author.id)) {
    await message.reply('Please wait 2 seconds before using another command.');
    return;
  }

  // Handle prefix command using the command handler
  try {
    await handlePrefixCommand(message, prefix);
  } catch (error) {
    console.error('Unhandled prefix command error:', error);
  }
});

client.on('messageUpdate', (oldMessage, newMessage) => {
  handleMessageUpdate(oldMessage, newMessage)
    .catch(error => console.error('Unhandled message update logging error:', error));
});

client.on('messageDelete', message => {
  handleMessageDelete(message)
    .catch(error => console.error('Unhandled message delete logging error:', error));
});

client.on('messageDeleteBulk', async messages => {
  for (const message of messages.values()) {
    try {
      await handleMessageDelete(message);
    } catch (error) {
      console.error('Unhandled bulk message delete logging error:', error);
    }
  }
});

client.on('messageReactionAdd', (reaction, user) => {
  handleMessageReactionAdd(reaction, user)
    .catch(error => console.error('Unhandled reaction command error:', error));
});

client.on('guildMemberAdd', member => {
  handleMemberJoin(member)
    .catch(error => console.error('Unhandled member join logging error:', error));
});

client.on('guildMemberRemove', member => {
  handleMemberLeave(member)
    .catch(error => console.error('Unhandled member leave logging error:', error));
});

client.on('voiceStateUpdate', (oldState, newState) => {
  handleVoiceStateUpdate(oldState, newState)
    .catch(error => console.error('Unhandled voice state logging error:', error));
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    if (!allowButton(interaction.user.id)) {
      await interaction.reply({
        content: 'Please wait 2 seconds before using another button.',
        ephemeral: true
      });
      return;
    }
    try {
      await handleButtonInteraction(interaction);
    } catch (error) {
      console.error('Unhandled button interaction error:', error);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!allowCommand(interaction.user.id)) {
    await interaction.reply({
      content: 'Please wait 2 seconds before using another command.',
      ephemeral: true
    });
    return;
  }

  // Handle slash command using the command handler
  try {
    await handleSlashCommand(interaction);
  } catch (error) {
    console.error('Unhandled slash command error:', error);
  }
});

client.login(token);
