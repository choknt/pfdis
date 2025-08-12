import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes, REST, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, InteractionType } from 'discord.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import express from 'express';
import PlayFab from 'playfab-sdk';

dotenv.config();

// ---------- CONFIG ----------
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  MONGO_URI,
  PLAYFAB_TITLE_ID,
  LOG_CHANNEL_ID,
  ADMIN_ROLE_ID,
  FORM_IMAGE_URL
} = process.env;

// ---------- MONGODB ----------
const playerSchema = new mongoose.Schema({
  discordId: String,
  discordName: String,
  gameId: String,
  gameName: String
});
const Player = mongoose.model('Player', playerSchema);

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

// ---------- PLAYFAB ----------
PlayFab.settings.titleId = PLAYFAB_TITLE_ID;

// helper: get gameName from PlayFabId
async function getGameNameById(playfabId) {
  return new Promise((resolve) => {
    PlayFab.Client.GetAccountInfo({ PlayFabId: playfabId }, (result, error) => {
      if (result && result.data && result.data.AccountInfo && result.data.AccountInfo.TitleInfo) {
        resolve(result.data.AccountInfo.TitleInfo.DisplayName || null);
      } else {
        resolve(null);
      }
    });
  });
}

// ---------- COMMANDS ----------
const commands = [
  new SlashCommandBuilder()
    .setName('send-form')
    .setDescription('ส่งฟอร์มยืนยันตัวตน'),
  new SlashCommandBuilder()
    .setName('show')
    .setDescription('แสดงข้อมูลการยืนยันของตัวเอง'),
  new SlashCommandBuilder()
    .setName('edit')
    .setDescription('แก้ไขไอดีเกมของตัวเอง'),
  new SlashCommandBuilder()
    .setName('py-info')
    .setDescription('ดูข้อมูลผู้เล่นจาก PlayFab ID (admin)')
    .addStringOption(opt => opt.setName('id').setDescription('PlayFabId').setRequired(true)),
  new SlashCommandBuilder()
    .setName('admin-show')
    .setDescription('ดูข้อมูลของผู้ใช้ที่ยืนยันแล้ว (admin)')
    .addStringOption(opt => opt.setName('discord_name').setDescription('ชื่อ Discord').setRequired(true)),
  new SlashCommandBuilder()
    .setName('admin-edit')
    .setDescription('แก้ไขไอดีเกมของผู้ใช้ (admin)')
    .addStringOption(opt => opt.setName('discord_name').setDescription('ชื่อ Discord').setRequired(true))
].map(cmd => cmd.toJSON());

// ---------- REGISTER COMMANDS ----------
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
    console.log('Commands registered.');
  } catch (err) {
    console.error(err);
  }
})();

// ---------- EVENT HANDLERS ----------
client.on('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await mongoose.connect(MONGO_URI);
  console.log('✅ Mongo connected');
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'send-form') {
      const embed = new EmbedBuilder()
        .setTitle('โปรดยืนยันว่าคุณเป็นผู้เล่น')
        .setDescription('โปรดกดปุ่มด้านล่างเพื่อกรอก ID ผู้เล่นของคุณ')
        .setImage(FORM_IMAGE_URL || null)
        .setColor(0x00AE86);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('verify_button')
          .setLabel('ไอดีของคุณ')
          .setStyle(ButtonStyle.Primary)
      );
      await interaction.reply({ embeds: [embed], components: [row] });
    }

    if (commandName === 'show') {
      const data = await Player.findOne({ discordId: interaction.user.id });
      if (!data) return interaction.reply({ content: 'คุณยังไม่ได้ยืนยันตัวตน', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle('ข้อมูลการยืนยันของคุณ')
        .addFields(
          { name: 'ไอดีเกม', value: data.gameId },
          { name: 'ชื่อผู้เล่น', value: data.gameName },
          { name: 'ไอดี Discord', value: data.discordId },
          { name: 'ชื่อ Discord', value: data.discordName }
        )
        .setColor(0x00AE86);
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'edit') {
      const modal = new ModalBuilder()
        .setCustomId('edit_modal')
        .setTitle('แก้ไขไอดีเกมของคุณ');
      const input = new TextInputBuilder()
        .setCustomId('edit_gameid')
        .setLabel('ไอดีเกมใหม่')
        .setPlaceholder('เช่น 25CDF5286DC38DAD')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }

    if (commandName === 'py-info') {
      if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: 'ไม่มีสิทธิ์', ephemeral: true });
      const id = interaction.options.getString('id');
      const name = await getGameNameById(id);
      await interaction.reply({ content: name ? `ชื่อผู้เล่น: ${name}` : 'ไม่พบข้อมูล' });
    }

    if (commandName === 'admin-show') {
      if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: 'ไม่มีสิทธิ์', ephemeral: true });
      const discordName = interaction.options.getString('discord_name');
      const data = await Player.findOne({ discordName });
      if (!data) return interaction.reply({ content: 'ไม่พบข้อมูล', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle(`ข้อมูลของ ${discordName}`)
        .addFields(
          { name: 'ไอดีเกม', value: data.gameId },
          { name: 'ชื่อผู้เล่น', value: data.gameName },
          { name: 'ไอดี Discord', value: data.discordId },
          { name: 'ชื่อ Discord', value: data.discordName }
        )
        .setColor(0x00AE86);
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'admin-edit') {
      if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: 'ไม่มีสิทธิ์', ephemeral: true });
      const discordName = interaction.options.getString('discord_name');
      const modal = new ModalBuilder()
        .setCustomId(`admin_edit_modal_${discordName}`)
        .setTitle(`แก้ไขไอดีเกมของ ${discordName}`);
      const input = new TextInputBuilder()
        .setCustomId('admin_edit_gameid')
        .setLabel('ไอดีเกมใหม่')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
  }

  // ---------- BUTTON ----------
  if (interaction.isButton()) {
    if (interaction.customId === 'verify_button') {
      const modal = new ModalBuilder()
        .setCustomId('verify_modal')
        .setTitle('โปรดป้อนไอดีเกมของคุณ');
      const input = new TextInputBuilder()
        .setCustomId('verify_gameid')
        .setLabel('ไอดีเกม')
        .setPlaceholder('เช่น 25CDF5286DC38DAD')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
  }

  // ---------- MODALS ----------
  if (interaction.type === InteractionType.ModalSubmit) {
    if (interaction.customId === 'verify_modal') {
      const gameId = interaction.fields.getTextInputValue('verify_gameid');
      const name = await getGameNameById(gameId);
      if (!name) {
        await interaction.user.send({ content: `ไม่พบ ${gameId} ในระบบ โปรดลองอีกครั้ง` });
        return interaction.reply({ content: 'ไม่พบข้อมูล', ephemeral: true });
      }
      const data = await Player.findOneAndUpdate(
        { discordId: interaction.user.id },
        { discordId: interaction.user.id, discordName: interaction.user.username, gameId, gameName: name },
        { upsert: true, new: true }
      );
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (logChannel) {
        const embed = new EmbedBuilder()
          .setTitle('ผู้ใช้ยืนยันตัวตนแล้ว')
          .addFields(
            { name: 'ไอดี Discord', value: data.discordId },
            { name: 'ชื่อ Discord', value: data.discordName },
            { name: 'ไอดีเกม', value: data.gameId },
            { name: 'ชื่อผู้เล่น', value: data.gameName }
          );
        logChannel.send({ embeds: [embed] });
      }
      await interaction.user.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('ยืนยันผ่าน')
            .addFields(
              { name: 'ไอดีเกม', value: gameId },
              { name: 'ชื่อผู้เล่น', value: name },
              { name: 'ไอดี Discord', value: interaction.user.id },
              { name: 'ชื่อ Discord', value: interaction.user.username }
            )
        ]
      });
      await interaction.reply({ content: 'ยืนยันสำเร็จ', ephemeral: true });
    }

    if (interaction.customId === 'edit_modal') {
      const gameId = interaction.fields.getTextInputValue('edit_gameid');
      const name = await getGameNameById(gameId);
      if (!name) return interaction.reply({ content: 'ไม่พบข้อมูล', ephemeral: true });
      await Player.findOneAndUpdate(
        { discordId: interaction.user.id },
        { gameId, gameName: name }
      );
      await interaction.reply({ content: 'แก้ไขข้อมูลสำเร็จ', ephemeral: true });
    }

    if (interaction.customId.startsWith('admin_edit_modal_')) {
      const discordName = interaction.customId.replace('admin_edit_modal_', '');
      const gameId = interaction.fields.getTextInputValue('admin_edit_gameid');
      const name = await getGameNameById(gameId);
      if (!name) return interaction.reply({ content: 'ไม่พบข้อมูล', ephemeral: true });
      await Player.findOneAndUpdate(
        { discordName },
        { gameId, gameName: name }
      );
      await interaction.reply({ content: 'แก้ไขข้อมูลสำเร็จ', ephemeral: true });
    }
  }
});

// ---------- EXPRESS HEALTH SERVER ----------
const app = express();
app.get('/health', (_req, res) => res.status(200).send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('HTTP health server running'));

// ---------- LOGIN ----------
client.login(DISCORD_TOKEN);
