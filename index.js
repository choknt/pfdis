// index.js — Discord Bot + PlayFab Verify + Mongo + Express /health
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import PlayFab from 'playfab-sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
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
  TextInputStyle
} from 'discord.js';

/* ========= ENV ========= */
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const MONGO_URI = process.env.MONGO_URI;
const TITLE_ID = process.env.PLAYFAB_TITLE_ID;

// ศูนย์กลางตรวจสิทธิ์ (Server A)
const PRIMARY_GUILD_ID = process.env.PRIMARY_GUILD_ID;
const ADMIN_ROLE_ID_A  = process.env.ADMIN_ROLE_ID_A;

// ห้อง log (ถ้าไม่ตั้งจะใช้ค่าที่โจทย์ให้)
const LOG_CHANNEL_ID_A = process.env.LOG_CHANNEL_ID_A || '1404414214839341056';

// เซิร์ฟเวอร์/บทบาทสำหรับให้บทบาทหลังยืนยัน
const GRANT_GUILD_ID  = '1127540917667119125';
const ALWAYS_ROLE_IDS = ['1127540917683888152','1414626804190150787']; // ให้เสมอ
const CLAN_ROLE_ID    = '1139181683300634664'; // ให้ถ้าอยู่ในลิสต์แคลน

const FORM_IMAGE_URL = process.env.FORM_IMAGE_URL; // optional
const PORT = process.env.PORT || 3000;

for (const [k, v] of Object.entries({
  TOKEN, CLIENT_ID, MONGO_URI, TITLE_ID, PRIMARY_GUILD_ID, ADMIN_ROLE_ID_A
})) {
  if (!v) { console.error('❌ Missing env:', k); process.exit(1); }
}

/* ========= Mongo Models ========= */
const Verify = mongoose.model(
  'Verify',
  new mongoose.Schema({
    discordId:   { type: String, index: true, unique: true }, // 1 Discord ⇄ 1 doc
    discordName: { type: String, index: true },
    playFabId:   { type: String, index: true, unique: true }, // ป้องกันซ้ำระหว่างผู้ใช้
    playerName:  String
  }, { timestamps: true })
);

// ลิสต์ “แคลน” (PlayFabId ที่จะได้ Clan Role)
const ClanAllow = mongoose.model(
  'ClanAllow',
  new mongoose.Schema({
    playFabId:   { type: String, index: true, unique: true },
    playerName:  String
  }, { timestamps: true })
);

/* ========= PlayFab (Client API) ========= */
PlayFab.settings.titleId = TITLE_ID;
let playfabReady = false;
function ensurePlayFabLogin() {
  if (playfabReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const CustomId = 'bot-' + Math.random().toString(36).slice(2);
    PlayFab.PlayFabClient.LoginWithCustomID(
      { TitleId: TITLE_ID, CustomId, CreateAccount: true },
      (err) => {
        if (err) { console.error('❌ PlayFab login failed:', err); return resolve(false); }
        playfabReady = true; resolve(true);
      }
    );
  });
}
async function getAccountInfoByPlayFabId(playFabId) {
  const ok = await ensurePlayFabLogin();
  if (!ok) return { found: false, error: 'PlayFab session not ready' };
  return new Promise((resolve) => {
    PlayFab.PlayFabClient.GetAccountInfo({ PlayFabId: playFabId }, (err, res) => {
      if (err) return resolve({ found: false, error: err?.errorMessage || 'GetAccountInfo failed' });
      const a = res?.data?.AccountInfo || {};
      resolve({
        found: true,
        displayName: a?.TitleInfo?.DisplayName || null,
        username: a?.Username || null
      });
    });
  });
}

/* ========= Discord Client ========= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // เปิด Server Members Intent ใน Dev Portal
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

/* ========= Helpers ========= */
async function isAdminInPrimaryGuild(userId) {
  try {
    const guildA = await client.guilds.fetch(PRIMARY_GUILD_ID);
    const memberA = await guildA.members.fetch(userId);
    return memberA.roles.cache.has(ADMIN_ROLE_ID_A);
  } catch (e) {
    console.warn('isAdminInPrimaryGuild error:', e?.message);
    return false;
  }
}
async function logToPrimaryGuild(embed) {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID_A);
    if (ch?.type === ChannelType.GuildText) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.warn('logToPrimaryGuild error:', e?.message);
  }
}

async function grantRolesAfterVerify(userId) {
  try {
    const guild = await client.guilds.fetch(GRANT_GUILD_ID);
    let member;
    try { member = await guild.members.fetch(userId); } catch { return { ok:false, reason:'not_in_guild' }; }
    for (const rid of ALWAYS_ROLE_IDS) {
      try { await member.roles.add(rid); } catch (e) { console.warn('add ALWAYS role error:', rid, e?.message); }
    }
    return { ok:true };
  } catch (e) {
    console.warn('grantRolesAfterVerify error:', e?.message);
    return { ok:false, reason:'fetch_guild_failed' };
  }
}
async function grantClanRoleIfAllowed(userId, playFabId) {
  try {
    const allowed = await ClanAllow.findOne({ playFabId });
    if (!allowed) return { ok:false, reason:'not_in_allow' };
    const guild = await client.guilds.fetch(GRANT_GUILD_ID);
    let member;
    try { member = await guild.members.fetch(userId); } catch { return { ok:false, reason:'not_in_guild' }; }
    try { await member.roles.add(CLAN_ROLE_ID); return { ok:true, wasAllowed:true, playerName: allowed.playerName || null }; }
    catch (e) { return { ok:false, reason:e?.message, wasAllowed:true, playerName: allowed.playerName || null }; }
  } catch (e) {
    console.warn('grantClanRoleIfAllowed error:', e?.message);
    return { ok:false, reason:'error' };
  }
}

/* ========= UI builders ========= */
const DEFAULT_FORM_IMAGE = 'https://i.imgur.com/7W0r3aY.png'; // สำรอง
function buildFormEmbed() {
  const e = new EmbedBuilder()
    .setTitle('โปรดยืนยันว่าคุณเป็นผู้เล่น โดยการป้อน ID ผู้เล่นของคุณ')
    .setDescription('กดปุ่ม **ไอดีของคุณ** เพื่อกรอก **PlayFabId**\\nตัวอย่าง: `25CDF5286DC38DAD`')
    .setColor(0x5865f2);
  e.setImage(FORM_IMAGE_URL || DEFAULT_FORM_IMAGE);
  return e;
}
function buildVerifyButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_verify_modal').setLabel('ไอดีของคุณ').setStyle(ButtonStyle.Primary)
  );
}
function buildVerifyModal() {
  const modal = new ModalBuilder().setCustomId('verify_modal').setTitle('โปรดป้อนไอดีของคุณ');
  const input = new TextInputBuilder()
    .setCustomId('playfab_id')
    .setLabel('ตัวอย่าง: 25CDF5286DC38DAD')
    .setPlaceholder('เช่น 25CDF5286DC38DAD')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ผู้ใช้/DM/ห้อง (ไม่โชว์ชื่อผู้เล่น)
function buildUserConfirmEmbed({ discordId, discordName, playFabId, clanStatusText }) {
  return new EmbedBuilder()
    .setTitle('ยืนยันผ่าน:')
    .setDescription('ตอนนี้คุณผ่านการยืนยัน')
    .addFields(
      { name: 'ไอดีเกม', value: playFabId, inline: false },
      { name: 'สถานะแคลน', value: clanStatusText || '—', inline: true },
      { name: 'ไอดี Discord', value: discordId, inline: true },
      { name: 'ชื่อ Discord', value: discordName || '—', inline: true }
    )
    .setColor(0x2ecc71)
    .setTimestamp();
}
// สำหรับ log (แอดมินเห็นชื่อผู้เล่นได้)
function buildLogEmbed({ discordId, discordName, playFabId, playerName, clan }) {
  return new EmbedBuilder()
    .setTitle('LOG: ยืนยันผู้เล่นสำเร็จ')
    .addFields(
      { name: 'ไอดีเกม', value: playFabId, inline: true },
      { name: 'ชื่อผู้เล่น', value: playerName || '—', inline: true },
      { name: 'แคลน', value: clan ? 'ใช่' : 'ไม่ใช่', inline: true },
      { name: 'Discord', value: `${discordName || '—'} (${discordId})`, inline: false }
    )
    .setColor(0x3498db)
    .setTimestamp();
}
function buildFailEmbed(playFabId) {
  return new EmbedBuilder()
    .setTitle('ไม่ผ่านการยืนยัน:')
    .setDescription(`เราไม่พบ **${playFabId}** ในระบบที่คุณส่งมา โปรดลองอีกครั้ง และโปรดตรวจสอบไอดีเกมให้ถูกต้อง`)
    .setImage(FORM_IMAGE_URL || DEFAULT_FORM_IMAGE)
    .setColor(0xe74c3c)
    .setTimestamp();
}

/* ========= Slash Commands ========= */
const commands = [
  // แอดมินส่งฟอร์ม (แสดงปุ่ม + โมดอล)
  new SlashCommandBuilder().setName('send-form').setDescription('ส่งฟอร์มยืนยันผู้เล่น (แอดมินเท่านั้น)').setDMPermission(true),

  // ผู้ใช้ดู/แก้ของตนเอง
  new SlashCommandBuilder().setName('show').setDescription('ดูข้อมูลของคุณ').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('edit')
    .setDescription('แก้ไข ID เกมของคุณ')
    .addStringOption(o => o.setName('playerid').setDescription('ไอดีใหม่ (PlayFabId)').setRequired(true))
    .setDMPermission(true),

  // แอดมินแคลน
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('เพิ่มไอดีเกมเข้าลิสต์แคลน (แอดมิน)')
    .addStringOption(o => o.setName('playerid').setDescription('PlayFabId').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('ลบไอดีเกมออกจากลิสต์แคลน (แอดมิน)')
    .addStringOption(o => o.setName('playerid').setDescription('PlayFabId').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('list')
    .setDescription('ดูรายชื่อไอดีในลิสต์แคลน (แอดมิน)')
    .setDMPermission(true),

  // แอดมิน info
  new SlashCommandBuilder()
    .setName('py-info')
    .setDescription('แสดงข้อมูลผู้เล่นจาก PlayFabId (ตรวจบทบาทใน Server A)')
    .addStringOption(o => o.setName('playerid').setDescription('PlayFabId').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('admin-show')
    .setDescription('ดูข้อมูลผู้ใช้ (ตรวจบทบาทใน Server A)')
    .addStringOption(o => o.setName('discord_name').setDescription('ชื่อ Discord เช่น user#1234').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('admin-edit')
    .setDescription('แก้ไขข้อมูลผู้ใช้ (ตรวจบทบาทใน Server A)')
    .addStringOption(o => o.setName('discord_name').setDescription('ชื่อ Discord').setRequired(true))
    .addStringOption(o => o.setName('playerid').setDescription('ไอดีเกมใหม่ (PlayFabId)').setRequired(true))
    .setDMPermission(true)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('✅ Global commands registered');
}

/* ========= Events ========= */
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // --- send-form (admin only) ---
      if (commandName === 'send-form') {
        const ok = await isAdminInPrimaryGuild(interaction.user.id);
        if (!ok) return interaction.reply({ content: '❌ คำสั่งนี้สำหรับแอดมินในเซิร์ฟเวอร์หลักเท่านั้น', ephemeral: true });
        return interaction.reply({ embeds: [buildFormEmbed()], components: [buildVerifyButtonRow()] });
      }

      // --- show (ของตัวเอง) — ไม่โชว์ชื่อผู้เล่น ---
      if (commandName === 'show') {
        const doc = await Verify.findOne({ discordId: interaction.user.id });
        if (!doc) return interaction.reply({ content: '❌ ยังไม่มีข้อมูลของคุณ', ephemeral: true });
        const userEmbed = buildUserConfirmEmbed({
          discordId: doc.discordId,
          discordName: doc.discordName,
          playFabId: doc.playFabId,
          clanStatusText: '—'
        });
        return interaction.reply({ embeds: [userEmbed], ephemeral: true });
      }

      // --- edit (ของตัวเอง) — ไม่ประกาศชื่อผู้เล่นกลับ ---
      if (commandName === 'edit') {
        const pid = interaction.options.getString('playerid', true).trim();

        // ตรวจว่า PlayFabId ใหม่นี้ถูกผู้อื่นใช้อยู่หรือไม่
        const taken = await Verify.findOne({ playFabId: pid });
        if (taken && taken.discordId !== interaction.user.id) {
          return interaction.reply({ content: `❌ PlayFabId นี้ถูกใช้งานโดยผู้ใช้อื่นแล้ว`, ephemeral: true });
        }

        const info = await getAccountInfoByPlayFabId(pid);
        if (!info.found) return interaction.reply({ embeds: [buildFailEmbed(pid)], ephemeral: true });

        try {
          await Verify.findOneAndUpdate(
            { discordId: interaction.user.id },
            {
              discordId: interaction.user.id,
              discordName: interaction.user.tag || interaction.user.username,
              playFabId: pid,
              playerName: info.displayName || info.username || null
            },
            { upsert: true, new: true }
          );
        } catch (e) {
          if (e?.code === 11000) {
            return interaction.reply({ content: `❌ PlayFabId นี้ถูกใช้งานโดยผู้ใช้อื่นแล้ว`, ephemeral: true });
          }
          throw e;
        }

        return interaction.reply({ content: `✅ อัปเดตไอดีเกมเรียบร้อย`, ephemeral: true });
      }

      // --- clan admin: /add ---
      if (commandName === 'add') {
        const ok = await isAdminInPrimaryGuild(interaction.user.id);
        if (!ok) return interaction.reply({ content:'❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral:true });

        const pid = interaction.options.getString('playerid', true).trim();
        const info = await getAccountInfoByPlayFabId(pid);
        if (!info.found) return interaction.reply({ content:'❌ ไม่พบไอดีนี้ใน PlayFab', ephemeral:true });

        try {
          await ClanAllow.findOneAndUpdate(
            { playFabId: pid },
            { playFabId: pid, playerName: info.displayName || info.username || null },
            { upsert:true, new:true }
          );
        } catch (e) {
          if (e?.code === 11000) {
            // แปลว่ามีอยู่แล้ว
          }
        }
        return interaction.reply({ content:`✅ เพิ่ม ${pid} เข้าลิสต์แคลนแล้ว`, ephemeral:true });
      }

      // --- clan admin: /delete ---
      if (commandName === 'delete') {
        const ok = await isAdminInPrimaryGuild(interaction.user.id);
        if (!ok) return interaction.reply({ content:'❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral:true });

        const pid = interaction.options.getString('playerid', true).trim();
        const del = await ClanAllow.findOneAndDelete({ playFabId: pid });
        if (!del) return interaction.reply({ content:'ℹ️ ไม่พบไอดีนี้ในลิสต์', ephemeral:true });
        return interaction.reply({ content:`✅ ลบ ${pid} ออกจากลิสต์แล้ว`, ephemeral:true });
      }

      // --- clan admin: /list ---
      if (commandName === 'list') {
        const ok = await isAdminInPrimaryGuild(interaction.user.id);
        if (!ok) return interaction.reply({ content:'❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral:true });

        const rows = await ClanAllow.find({}).sort({ createdAt: 1 }).lean();
        if (!rows.length) return interaction.reply({ content:'(ว่าง) ไม่มีรายการ', ephemeral:true });

        const body = rows.map(r => `${r.playFabId} ${r.playerName || '-'}`).join('\n');
        const e = new EmbedBuilder().setTitle('ลิสต์แคลน').setDescription(body).setColor(0x95a5a6);
        return interaction.reply({ embeds:[e], ephemeral:true });
      }

      // --- py-info (แอดมินทุกที่, ไม่ซ่อน) ---
      if (commandName === 'py-info') {
        const ok = await isAdminInPrimaryGuild(interaction.user.id);
        if (!ok) return interaction.reply({ content: '❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral: true });

        const pid = interaction.options.getString('playerid', true);
        const info = await getAccountInfoByPlayFabId(pid);
        if (!info.found) return interaction.reply({ content: '❌ ไม่พบผู้เล่น' });

        const embed = new EmbedBuilder()
          .setTitle('ข้อมูลผู้เล่น (Server A)')
          .addFields(
            { name: 'ไอดีเกม', value: pid, inline: true },
            { name: 'ชื่อผู้เล่น', value: info.displayName || info.username || '—', inline: true }
          )
          .setColor(0x00a8ff)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // --- admin-show (แอดมินทุกที่, ไม่ซ่อน) ---
      if (commandName === 'admin-show') {
        const ok = await isAdminInPrimaryGuild(interaction.user.id);
        if (!ok) return interaction.reply({ content: '❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral: true });

        const dname = interaction.options.getString('discord_name', true);
        const doc = await Verify.findOne({ discordName: dname });
        if (!doc) return interaction.reply({ content: '❌ ไม่พบข้อมูลของผู้ใช้ชื่อนี้' });

        const adminEmbed = new EmbedBuilder()
          .setTitle(`ข้อมูลของ ${dname}`)
          .addFields(
            { name: 'ไอดีเกม', value: doc.playFabId || '—', inline: true },
            { name: 'ชื่อผู้เล่น', value: doc.playerName || '—', inline: true },
            { name: 'Discord', value: `${doc.discordName} (${doc.discordId})`, inline: false }
          )
          .setColor(0x5865F2)
          .setTimestamp();

        return interaction.reply({ embeds: [adminEmbed] });
      }

      // --- admin-edit (แอดมินทุกที่, ไม่ซ่อน) ---
      if (commandName === 'admin-edit') {
        const ok = await isAdminInPrimaryGuild(interaction.user.id);
        if (!ok) return interaction.reply({ content: '❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral: true });

        const dname = interaction.options.getString('discord_name', true);
        const newPid = interaction.options.getString('playerid', true);

        // หา target ก่อน เพื่อเช็คว่า newPid ซ้ำคนอื่นหรือไม่
        const target = await Verify.findOne({ discordName: dname });
        if (!target) return interaction.reply({ content: '❌ ไม่พบผู้ใช้', ephemeral: true });

        const taken = await Verify.findOne({ playFabId: newPid });
        if (taken && taken.discordId !== target.discordId) {
          return interaction.reply({ content: `❌ PlayFabId นี้ถูกใช้งานโดยผู้ใช้อื่นแล้ว`, ephemeral: true });
        }

        const info = await getAccountInfoByPlayFabId(newPid);
        if (!info.found) return interaction.reply({ embeds: [buildFailEmbed(newPid)] });

        const updated = await Verify.findOneAndUpdate(
          { discordName: dname },
          { playFabId: newPid, playerName: info.displayName || info.username || null },
          { new: true }
        );

        const adminEmbed = new EmbedBuilder()
          .setTitle(`อัปเดตข้อมูลของ ${dname} สำเร็จ`)
          .addFields(
            { name: 'ไอดีเกม', value: updated.playFabId || '—', inline: true },
            { name: 'ชื่อผู้เล่น', value: updated.playerName || '—', inline: true },
            { name: 'Discord', value: `${updated.discordName} (${updated.discordId})`, inline: false }
          )
          .setColor(0x2ecc71)
          .setTimestamp();

        return interaction.reply({ embeds: [adminEmbed] });
      }
    }

    // ปุ่ม → เปิดโมดอล
    if (interaction.isButton() && interaction.customId === 'open_verify_modal') {
      try {
        return await interaction.showModal(buildVerifyModal());
      } catch (e) {
        console.error('showModal error:', e);
        if (interaction.isRepliable()) {
          try { await interaction.reply({ content: 'ไม่สามารถเปิดฟอร์มได้ กรุณาลองใหม่อีกครั้ง', ephemeral: true }); } catch {}
        }
      }
    }

    // โมดอล submit → บันทึก Mongo + ให้บทบาท + Log + DM/Reply (ไม่โชว์ชื่อผู้เล่น)
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'verify_modal') {
      const pfId = interaction.fields.getTextInputValue('playfab_id').trim();
      await interaction.deferReply({ ephemeral: true });

      const info = await getAccountInfoByPlayFabId(pfId);
      if (!info.found) {
        const fail = buildFailEmbed(pfId);
        try { await interaction.user.send({ embeds: [fail] }); } catch {}
        return interaction.editReply({ embeds: [fail] });
      }

      // ❗ ป้องกันซ้ำ: ถ้า PlayFabId นี้ถูกคนอื่นใช้แล้ว ห้ามยืนยัน
      const claimed = await Verify.findOne({ playFabId: pfId });
      if (claimed && claimed.discordId !== interaction.user.id) {
        const msg = new EmbedBuilder()
          .setTitle('ไม่สามารถยืนยันได้')
          .setDescription(`PlayFabId **${pfId}** ถูกใช้งานโดยผู้ใช้อื่นแล้ว`)
          .setColor(0xe74c3c);
        return interaction.editReply({ embeds: [msg] });
      }

      let doc;
      try {
        doc = await Verify.findOneAndUpdate(
          { discordId: interaction.user.id },
          {
            discordId: interaction.user.id,
            discordName: interaction.user.tag || interaction.user.username,
            playFabId: pfId,
            playerName: info.displayName || info.username || null
          },
          { upsert: true, new: true }
        );
      } catch (e) {
        if (e?.code === 11000) {
          const msg = new EmbedBuilder()
            .setTitle('ไม่สามารถยืนยันได้')
            .setDescription(`PlayFabId นี้ถูกใช้งานโดยผู้ใช้อื่นแล้ว`)
            .setColor(0xe74c3c);
          return interaction.editReply({ embeds: [msg] });
        }
        throw e;
      }

      // ให้บทบาทในกิลด์เป้าหมาย (สองบทบาทเสมอ)
      await grantRolesAfterVerify(interaction.user.id);

      // ถ้าอยู่ในลิสต์แคลน → ให้บทบาทแคลนเพิ่ม
      const clanGrant = await grantClanRoleIfAllowed(interaction.user.id, pfId);
      const isClan = !!(clanGrant.wasAllowed);

      // Log (ระบุชื่อผู้เล่นได้)
      const logEmbed = buildLogEmbed({
        discordId: doc.discordId,
        discordName: doc.discordName,
        playFabId: doc.playFabId,
        playerName: doc.playerName,
        clan: isClan
      });
      await logToPrimaryGuild(logEmbed);

      // DM/Reply (ไม่ระบุชื่อผู้เล่น แต่บอกสถานะแคลน)
      const userEmbed = buildUserConfirmEmbed({
        discordId: doc.discordId,
        discordName: doc.discordName,
        playFabId: doc.playFabId,
        clanStatusText: isClan ? 'ยืนยันว่าเป็นคนในแคลน ✅' : 'ไม่พบในลิสต์แคลน'
      });

      try { await interaction.user.send({ embeds: [userEmbed] }); } catch {}
      return interaction.editReply({ content: 'บันทึกข้อมูลและยืนยันสำเร็จ ✅', embeds: [userEmbed] });
    }
  } catch (e) {
    console.error('Interaction error:', e);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'เกิดข้อผิดพลาดภายในระบบ', ephemeral: true }); } catch {}
    }
  }
});

/* ========= Health server ========= */
const app = express();
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', time: new Date().toISOString() }));
app.listen(PORT, () => console.log('HTTP health server on', PORT));

/* ========= Bootstrap ========= */
(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Mongo connected');
    const ok = await ensurePlayFabLogin();
    if (!ok) throw new Error('PlayFab login failed');
    console.log('✅ PlayFab session ready');
    await client.login(TOKEN);
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();