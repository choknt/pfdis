import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import PlayFab from 'playfab-sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionType,
  ModalBuilder,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType
} from 'discord.js';

// ===== ENV =====
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

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !MONGO_URI || !PLAYFAB_TITLE_ID) {
  console.error('❌ Missing required env vars. Please check .env');
  process.exit(1);
}

// ===== Mongo =====
const verifySchema = new mongoose.Schema(
  {
    discordId: { type: String, index: true, unique: true },
    discordName: { type: String, index: true },
    playFabId: { type: String, index: true },
    playerName: String
  },
  { timestamps: true }
);
const Verify = mongoose.model('Verify', verifySchema);

// ===== PlayFab (Client API in Node) =====
PlayFab.settings.titleId = PLAYFAB_TITLE_ID;
let playfabReady = false;
function ensurePlayFabLogin() {
  if (playfabReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const CustomId = 'bot-' + Math.random().toString(36).slice(2);
    PlayFab.PlayFabClient.LoginWithCustomID({ TitleId: PLAYFAB_TITLE_ID, CustomId, CreateAccount: true }, (err) => {
      if (err) {
        console.error('❌ PlayFab login failed:', err);
        return resolve(false);
      }
      playfabReady = true;
      resolve(true);
    });
  });
}

async function getAccountInfoByPlayFabId(playFabId) {
  const ok = await ensurePlayFabLogin();
  if (!ok) return { found: false, error: 'PlayFab session not ready' };
  return new Promise((resolve) => {
    PlayFab.PlayFabClient.GetAccountInfo({ PlayFabId: playFabId }, (err, res) => {
      if (err) return resolve({ found: false, error: err?.errorMessage || 'GetAccountInfo failed' });
      const a = res?.data?.AccountInfo || {};
      const displayName = a?.TitleInfo?.DisplayName || null;
      const username = a?.Username || null;
      const created = a?.TitleInfo?.Created || null;
      resolve({ found: true, displayName, username, created });
    });
  });
}

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

// ===== Helpers =====
const isDM = (interaction) => !interaction.guild;
const requireAdmin = (interaction) => interaction.guild && ADMIN_ROLE_ID && interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID);
const fmt = (dt) => { if (!dt) return '—'; const d = new Date(dt); return isNaN(d) ? String(dt) : d.toLocaleString(); };

// ===== Slash Commands (DM enabled for user cmds) =====
const commands = [
  new SlashCommandBuilder().setName('send-form').setDescription('ส่งข้อความยืนยันตัวตน (มีปุ่ม+โมดอล)').setDMPermission(true),
  new SlashCommandBuilder().setName('show').setDescription('แสดงข้อมูลยืนยันของตัวเอง').setDMPermission(true),
  new SlashCommandBuilder().setName('edit').setDescription('แก้ไขไอดีเกมของตัวเอง').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('py-info')
    .setDescription('แสดงข้อมูลผู้เล่นจาก PlayFabId (เฉพาะแอดมินในกิลด์)')
    .addStringOption(o => o.setName('id').setDescription('PlayFabId').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('admin-show')
    .setDescription('แสดงข้อมูลที่ผู้ใช้ส่งมายืนยัน (เฉพาะแอดมิน)')
    .addStringOption(o => o.setName('discord_name').setDescription('ชื่อ Discord (เช่น user#1234)').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('admin-edit')
    .setDescription('แก้ไขข้อมูลยืนยันของผู้ใช้ (เฉพาะแอดมิน)')
    .addStringOption(o => o.setName('discord_name').setDescription('ชื่อ Discord (เช่น user#1234)').setRequired(true))
    .setDMPermission(false)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  // Guild (ขึ้นไว)
  if (DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
    console.log('✅ Guild commands registered');
  }
  // Global (ใช้ใน DM)
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log('✅ Global commands registered');
}

// ===== UI Builders =====
function buildFormEmbed() {
  const e = new EmbedBuilder()
    .setTitle('โปรดยืนยันว่าคุณเป็นผู้เล่น')
    .setDescription('กดปุ่ม **ไอดีของคุณ** เพื่อกรอก **PlayFabId**
ตัวอย่าง: `25CDF5286DC38DAD`')
    .setColor(0x5865F2);
  if (FORM_IMAGE_URL) e.setImage(FORM_IMAGE_URL);
  return e;
}
function buildVerifyButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_verify_modal').setLabel('ไอดีของคุณ').setStyle(ButtonStyle.Primary)
  );
}
function buildVerifyModal(customId = 'verify_modal', title = 'ยืนยันผู้เล่น (PlayFab)') {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId('playfab_id')
    .setLabel('โปรดป้อน PlayFabId ของคุณ (เช่น 25CDF5286DC38DAD)')
    .setPlaceholder('เช่น 25CDF5286DC38DAD')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}
function buildUserEmbed({ discordId, discordName, playFabId, playerName }) {
  return new EmbedBuilder()
    .setTitle('ยืนยันผ่าน')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'ไอดีเกม', value: playFabId, inline: false },
      { name: 'ชื่อผู้เล่น', value: playerName || '—', inline: false },
      { name: 'ไอดี Discord', value: discordId, inline: true },
      { name: 'ชื่อ Discord', value: discordName || '—', inline: true }
    )
    .setTimestamp();
}
function buildFailEmbed(playFabId) {
  return new EmbedBuilder()
    .setTitle('ไม่ผ่านการยืนยัน')
    .setDescription(`เราไม่พบ **${playFabId}** ในระบบ โปรดตรวจสอบและลองใหม่อีกครั้ง`)
    .setColor(0xe74c3c)
    .setTimestamp();
}

// ===== Discord Events =====
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'send-form') {
        return interaction.reply({ embeds: [buildFormEmbed()], components: [buildVerifyButtonRow()], ephemeral: isDM(interaction) });
      }

      if (commandName === 'show') {
        const doc = await Verify.findOne({ discordId: interaction.user.id });
        if (!doc) return interaction.reply({ content: 'ยังไม่มีข้อมูลยืนยันของคุณ', ephemeral: true });
        return interaction.reply({ embeds: [buildUserEmbed(doc)], ephemeral: true });
      }

      if (commandName === 'edit') {
        return interaction.showModal(buildVerifyModal('verify_modal', 'แก้ไข/ยืนยันไอดีเกมของคุณ'));
      }

      if (commandName === 'py-info') {
        if (!requireAdmin(interaction)) return interaction.reply({ content: 'ต้องมีบทบาทแอดมิน', ephemeral: true });
        const pid = interaction.options.getString('id', true);
        await interaction.deferReply({ ephemeral: true });
        const info = await getAccountInfoByPlayFabId(pid);
        if (!info.found) return interaction.editReply('ไม่พบผู้เล่นหรือเกิดข้อผิดพลาด: ' + (info.error || ''));
        const embed = new EmbedBuilder()
          .setTitle('ข้อมูลผู้เล่น (py-info)')
          .setColor(0x00a8ff)
          .addFields(
            { name: 'ไอดี', value: pid, inline: false },
            { name: 'ชื่อผู้เล่น', value: info.displayName || info.username || '—', inline: true },
            { name: 'วันสร้าง', value: fmt(info.created), inline: true }
          ).setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (commandName === 'admin-show') {
        if (!requireAdmin(interaction)) return interaction.reply({ content: 'ต้องมีบทบาทแอดมิน', ephemeral: true });
        const name = interaction.options.getString('discord_name', true);
        const doc = await Verify.findOne({ discordName: name });
        if (!doc) return interaction.reply({ content: 'ไม่พบข้อมูลของผู้ใช้ชื่อนี้', ephemeral: true });
        return interaction.reply({ embeds: [buildUserEmbed(doc)], ephemeral: true });
      }

      if (commandName === 'admin-edit') {
        if (!requireAdmin(interaction)) return interaction.reply({ content: 'ต้องมีบทบาทแอดมิน', ephemeral: true });
        const name = interaction.options.getString('discord_name', true);
        const doc = await Verify.findOne({ discordName: name });
        if (!doc) return interaction.reply({ content: 'ไม่พบข้อมูลของผู้ใช้ชื่อนี้', ephemeral: true });
        const modal = buildVerifyModal(`admin_edit_modal:${doc.discordId}`, `แก้ไขไอดีเกมของ ${name}`);
        return interaction.showModal(modal);
      }

      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'open_verify_modal') {
        return interaction.showModal(buildVerifyModal());
      }
      return;
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      const pfId = interaction.fields.getTextInputValue('playfab_id').trim();

      // admin edit
      if (interaction.customId.startsWith('admin_edit_modal:')) {
        if (!requireAdmin(interaction)) return interaction.reply({ content: 'ต้องมีบทบาทแอดมิน', ephemeral: true });
        const targetDiscordId = interaction.customId.split(':')[1];
        await interaction.deferReply({ ephemeral: true });
        const info = await getAccountInfoByPlayFabId(pfId);
        if (!info.found) return interaction.editReply({ embeds: [buildFailEmbed(pfId)] });
        const playerName = info.displayName || info.username || null;
        const doc = await Verify.findOneAndUpdate(
          { discordId: targetDiscordId },
          { playFabId: pfId, playerName },
          { new: true }
        );
        return interaction.editReply({ content: 'แก้ไขข้อมูลสำเร็จ', embeds: [buildUserEmbed(doc)] });
      }

      // self verify/edit
      if (interaction.customId === 'verify_modal') {
        await interaction.deferReply({ ephemeral: true });
        const info = await getAccountInfoByPlayFabId(pfId);
        if (!info.found) {
          try { await interaction.user.send({ embeds: [buildFailEmbed(pfId)] }); } catch {}
          return interaction.editReply({ embeds: [buildFailEmbed(pfId)] });
        }
        const playerName = info.displayName || info.username || null;
        const payload = { discordId: interaction.user.id, discordName: interaction.user.tag, playFabId: pfId, playerName };
        const doc = await Verify.findOneAndUpdate({ discordId: interaction.user.id }, payload, { upsert: true, new: true, setDefaultsOnInsert: true });

        const successEmbed = buildUserEmbed(doc);
        try { await interaction.user.send({ embeds: [successEmbed] }); } catch {}

        try {
          if (LOG_CHANNEL_ID) {
            const ch = await client.channels.fetch(LOG_CHANNEL_ID);
            if (ch?.type === ChannelType.GuildText) await ch.send({ embeds: [successEmbed] });
          }
        } catch (e) { console.warn('log channel error', e?.message); }

        return interaction.editReply({ content: 'บันทึกข้อมูลและยืนยันสำเร็จ ✅', embeds: [successEmbed] });
      }
    }
  } catch (e) {
    console.error('Interaction error:', e);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'เกิดข้อผิดพลาดภายในระบบ', ephemeral: true }); } catch {}
    }
  }
});

// ===== HTTP Health Server (/health) =====
const app = express();
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', time: new Date().toISOString() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP health server on', PORT));

// ===== Bootstrap =====
(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Mongo connected');
    const ok = await ensurePlayFabLogin();
    if (!ok) throw new Error('PlayFab login failed');
    console.log('✅ PlayFab session ready');
    await client.login(DISCORD_TOKEN);
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();


อัปเดตโค้ด ทั้งหมด ให้เรียบร้อยแล้วในแคนวาสด้านขวา ✅

แก้ dependency playfab-sdk เป็นเวอร์ชันที่มีจริง (2.179.250801)

ปรับ index.js ครบชุด: Slash commands, Modals, DM ได้, เช็คสิทธิ์แอดมิน, บันทึก Mongo, ส่ง Log, DM ผลลัพธ์, และมี /health (พร้อม / health) สำหรับ Render

เพิ่ม .env.example และ package.json พร้อมใช้


เช็คลิสต์ Deploy (Render)

1. ลบ package-lock.json (ถ้ามี) แล้วคอมมิตโค้ดใหม่


2. ตั้งค่า Environment Variables ให้ครบ (ดูใน .env.example)


3. เลือก Background Worker หรือ Web Service (มี /health)


4. ดู Log ให้ขึ้น:

✅ Mongo connected
✅ PlayFab session ready
🤖 Logged in as <BotName>
HTTP health server on <PORT>



ถ้าคุณเจอ error อะไรตอน build/run ให้ก็อปลอกรันไทม์มาวางได้เลย ผมจะไล่แก้ให้จนผ่านครับ 💪

