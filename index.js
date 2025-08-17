import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Partials, Routes, REST, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionType } from 'discord.js';
import mongoose from 'mongoose';
import PlayFab from 'playfab-sdk';

// === CONFIG ===
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  MONGO_URI,
  PLAYFAB_TITLE_ID,
  LOG_CHANNEL_ID,
  ADMIN_ROLE_ID,
  PORT = 3000
} = process.env;

// === MONGO MODEL ===
const playerSchema = new mongoose.Schema({
  discordId: String,
  discordName: String,
  playerId: String,
  playerName: String
});
const Player = mongoose.model('Player', playerSchema);

// === PLAYFAB INIT ===
PlayFab.settings.titleId = PLAYFAB_TITLE_ID;

// === DISCORD CLIENT ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// === REGISTER COMMANDS ===
const commands = [
  { name: 'send-form', description: 'ส่งฟอร์มยืนยันตัวตนผู้เล่น' },
  { name: 'show', description: 'ดูข้อมูลการยืนยันของคุณ' },
  { name: 'edit', description: 'แก้ไขไอดีเกมของคุณ' },
  {
    name: 'py-info',
    description: 'ตรวจสอบข้อมูลผู้เล่น (Admin เท่านั้น)',
    options: [{ name: 'playerid', type: 3, description: 'ไอดีผู้เล่น', required: true }]
  },
  {
    name: 'admin-show',
    description: 'แสดงข้อมูลของผู้ใช้ (Admin เท่านั้น)',
    options: [{ name: 'discordname', type: 3, description: 'ชื่อ Discord', required: true }]
  },
  {
    name: 'admin-edit',
    description: 'แก้ไขข้อมูลของผู้ใช้ (Admin เท่านั้น)',
    options: [
      { name: 'discordname', type: 3, description: 'ชื่อ Discord', required: true },
      { name: 'playerid', type: 3, description: 'ไอดีผู้เล่นใหม่', required: true }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// === EXPRESS HEALTH CHECK ===
const app = express();
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`HTTP health server on ${PORT}`));

// === HELPER: Get Player Info ===
function getPlayerName(playerId) {
  return new Promise((resolve, reject) => {
    PlayFab.PlayFabClient.GetAccountInfo({ PlayFabId: playerId }, (err, res) => {
      if (err || !res?.data) return reject(err || new Error('ไม่พบผู้เล่น'));
      resolve(res.data.AccountInfo.TitleInfo?.DisplayName || 'Unknown');
    });
  });
}

// === DISCORD EVENTS ===
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  // Register slash commands globally
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log('✅ Slash commands registered');
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'send-form') {
        const btn = new ButtonBuilder()
          .setCustomId('verifyBtn')
          .setLabel('ไอดีของคุณ')
          .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(btn);

        const embed = new EmbedBuilder()
          .setTitle('โปรดยืนยันว่าคุณเป็นผู้เล่น')
          .setDescription('กดปุ่มด้านล่างเพื่อกรอก ID ผู้เล่นของคุณ')
          .setColor('Blue')
          .setImage('https://i.imgur.com/xG74tFQ.png');

        await interaction.reply({ embeds: [embed], components: [row] });
      }

      if (interaction.commandName === 'show') {
        const data = await Player.findOne({ discordId: interaction.user.id });
        if (!data) return interaction.reply({ content: '❌ คุณยังไม่ได้ยืนยัน', ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle('ข้อมูลการยืนยันของคุณ')
          .addFields(
            { name: 'ไอดีเกม', value: data.playerId, inline: true },
            { name: 'ชื่อผู้เล่น', value: data.playerName, inline: true },
            { name: 'ชื่อ Discord', value: data.discordName, inline: true }
          )
          .setColor('Green');

        await interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === 'edit') {
        const modal = new ModalBuilder()
          .setCustomId('editModal')
          .setTitle('แก้ไขไอดีเกม');
        const input = new TextInputBuilder()
          .setCustomId('newPlayerId')
          .setLabel('ใส่ไอดีเกมใหม่')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
      }

      if (interaction.commandName === 'py-info') {
        if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID))
          return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์', ephemeral: true });
        const pid = interaction.options.getString('playerid');
        try {
          const name = await getPlayerName(pid);
          const embed = new EmbedBuilder()
            .setTitle('ข้อมูลผู้เล่น')
            .addFields(
              { name: 'ไอดีเกม', value: pid },
              { name: 'ชื่อผู้เล่น', value: name }
            )
            .setColor('Blue');
          await interaction.reply({ embeds: [embed] });
        } catch {
          await interaction.reply({ content: `❌ ไม่พบผู้เล่น ${pid}`, ephemeral: true });
        }
      }

      if (interaction.commandName === 'admin-show') {
        if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID))
          return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์', ephemeral: true });
        const dname = interaction.options.getString('discordname');
        const data = await Player.findOne({ discordName: dname });
        if (!data) return interaction.reply({ content: '❌ ไม่พบข้อมูล', ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle(`ข้อมูลของ ${dname}`)
          .addFields(
            { name: 'ไอดีเกม', value: data.playerId },
            { name: 'ชื่อผู้เล่น', value: data.playerName },
            { name: 'Discord', value: data.discordName }
          )
          .setColor('Blue');
        await interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === 'admin-edit') {
        if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID))
          return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์', ephemeral: true });
        const dname = interaction.options.getString('discordname');
        const newId = interaction.options.getString('playerid');
        try {
          const name = await getPlayerName(newId);
          const data = await Player.findOneAndUpdate(
            { discordName: dname },
            { playerId: newId, playerName: name },
            { new: true }
          );
          if (!data) return interaction.reply({ content: '❌ ไม่พบผู้ใช้', ephemeral: true });
          await interaction.reply({ content: `✅ อัปเดต ${dname} เป็น ${name} แล้ว`, ephemeral: true });
        } catch {
          await interaction.reply({ content: `❌ ไม่พบผู้เล่น ${newId}`, ephemeral: true });
        }
      }
    }

    if (interaction.isButton() && interaction.customId === 'verifyBtn') {
      const modal = new ModalBuilder().setCustomId('verifyModal').setTitle('โปรดยืนยันไอดี');
      const input = new TextInputBuilder()
        .setCustomId('playerIdInput')
        .setLabel('กรอกไอดีเกมของคุณ')
        .setPlaceholder('ตัวอย่าง: 25CDF5286DC38DAD')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);
      await interaction.showModal(modal);
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === 'verifyModal') {
        const pid = interaction.fields.getTextInputValue('playerIdInput');
        try {
          const name = await getPlayerName(pid);

          const newPlayer = await Player.findOneAndUpdate(
            { discordId: interaction.user.id },
            { discordId: interaction.user.id, discordName: interaction.user.username, playerId: pid, playerName: name },
            { upsert: true, new: true }
          );

          // ส่ง log ไปห้อง
          const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
          if (logChannel) {
            const embed = new EmbedBuilder()
              .setTitle('การยืนยันใหม่')
              .addFields(
                { name: 'Discord', value: `${interaction.user.username} (${interaction.user.id})` },
                { name: 'ไอดีเกม', value: pid },
                { name: 'ชื่อผู้เล่น', value: name }
              )
              .setColor('Blue');
            logChannel.send({ embeds: [embed] });
          }

          // ส่ง DM
          const embed = new EmbedBuilder()
            .setTitle('✅ ยืนยันผ่านแล้ว')
            .addFields(
              { name: 'ไอดีเกม', value: pid },
              { name: 'ชื่อผู้เล่น', value: name },
              { name: 'Discord', value: `${interaction.user.username} (${interaction.user.id})` }
            )
            .setColor('Green')
            .setTimestamp();
          await interaction.user.send({ embeds: [embed] });

          await interaction.reply({ content: '✅ ยืนยันเรียบร้อย! กรุณาตรวจสอบ DM', ephemeral: true });
        } catch {
          const embed = new EmbedBuilder()
            .setTitle('❌ ไม่ผ่านการยืนยัน')
            .setDescription(`เราไม่พบ **${pid}** ในระบบ โปรดลองใหม่`)
            .setColor('Red')
            .setImage('https://i.imgur.com/xG74tFQ.png');
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      }

      if (interaction.customId === 'editModal') {
        const newId = interaction.fields.getTextInputValue('newPlayerId');
        try {
          const name = await getPlayerName(newId);
          const data = await Player.findOneAndUpdate(
            { discordId: interaction.user.id },
            { playerId: newId, playerName: name },
            { new: true }
          );
          if (!data) return interaction.reply({ content: '❌ คุณยังไม่ได้ยืนยันมาก่อน', ephemeral: true });
          await interaction.reply({ content: `✅ อัปเดตไอดีเกมเป็น ${name}`, ephemeral: true });
        } catch {
          await interaction.reply({ content: `❌ ไม่พบผู้เล่น ${newId}`, ephemeral: true });
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
});

// === CONNECT DB & LOGIN ===
mongoose.connect(MONGO_URI).then(() => console.log('✅ Mongo connected'));
PlayFab.PlayFabClient.LoginWithCustomID(
  { TitleId: PLAYFAB_TITLE_ID, CustomId: 'bot-' + Date.now(), CreateAccount: true },
  (err) => {
    if (err) console.error('PlayFab login failed', err);
    else console.log('✅ PlayFab session ready');
  }
);

client.login(DISCORD_TOKEN);