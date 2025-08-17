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

// ===== ENV =====
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const MONGO_URI = process.env.MONGO_URI;
const TITLE_ID = process.env.PLAYFAB_TITLE_ID;
const PRIMARY_GUILD_ID = process.env.PRIMARY_GUILD_ID;
const ADMIN_ROLE_ID_A = process.env.ADMIN_ROLE_ID_A;
const LOG_CHANNEL_ID_A = process.env.LOG_CHANNEL_ID_A;
const FORM_IMAGE_URL = process.env.FORM_IMAGE_URL;
const PORT = process.env.PORT || 3000;

for (const [k,v] of Object.entries({TOKEN,CLIENT_ID,MONGO_URI,TITLE_ID,PRIMARY_GUILD_ID,ADMIN_ROLE_ID_A,LOG_CHANNEL_ID_A})){
  if(!v){ console.error('❌ Missing env:', k); process.exit(1); }
}

// ===== Mongo Model =====
const Verify = mongoose.model(
  'Verify',
  new mongoose.Schema({
    discordId: { type: String, index: true, unique: true },
    discordName: { type: String, index: true },
    playFabId: { type: String, index: true },
    playerName: String
  }, { timestamps: true })
);

// ===== PlayFab (Client API) =====
PlayFab.settings.titleId = TITLE_ID;
let playfabReady = false;
function ensurePlayFabLogin(){
  if (playfabReady) return Promise.resolve(true);
  return new Promise((resolve)=>{
    const CustomId = 'bot-' + Math.random().toString(36).slice(2);
    PlayFab.PlayFabClient.LoginWithCustomID({ TitleId: TITLE_ID, CustomId, CreateAccount: true }, (err)=>{
      if (err) { console.error('❌ PlayFab login failed:', err); return resolve(false); }
      playfabReady = true; resolve(true);
    });
  });
}
async function getAccountInfoByPlayFabId(playFabId){
  const ok = await ensurePlayFabLogin();
  if(!ok) return { found:false, error:'PlayFab session not ready' };
  return new Promise((resolve)=>{
    PlayFab.PlayFabClient.GetAccountInfo({ PlayFabId: playFabId }, (err, res)=>{
      if (err) return resolve({ found:false, error: err?.errorMessage || 'GetAccountInfo failed' });
      const a = res?.data?.AccountInfo || {};
      resolve({
        found: true,
        displayName: a?.TitleInfo?.DisplayName || null,
        username: a?.Username || null
      });
    });
  });
}

// ===== Discord Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // เปิด Server Members Intent ใน Dev Portal
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// ===== Server A helpers =====
async function isAdminInPrimaryGuild(userId){
  try {
    const guildA = await client.guilds.fetch(PRIMARY_GUILD_ID);
    const memberA = await guildA.members.fetch(userId);
    return memberA.roles.cache.has(ADMIN_ROLE_ID_A);
  } catch(e){ console.warn('isAdminInPrimaryGuild error:', e?.message); return false; }
}
async function logToPrimaryGuild(embed){
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID_A);
    if (ch?.type === ChannelType.GuildText) await ch.send({ embeds: [embed] });
  } catch(e){ console.warn('logToPrimaryGuild error:', e?.message); }
}

// ===== UI builders =====
function buildFormEmbed(){
  const e = new EmbedBuilder()
    .setTitle('โปรดยืนยันว่าคุณเป็นผู้เล่น')
    .setDescription('กดปุ่ม **ไอดีของคุณ** เพื่อกรอก **PlayFabId**\nตัวอย่าง: `25CDF5286DC38DAD`')
    .setColor(0x5865f2);
  if (FORM_IMAGE_URL) e.setImage(FORM_IMAGE_URL);
  return e;
}
function buildVerifyButtonRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_verify_modal').setLabel('ไอดีของคุณ').setStyle(ButtonStyle.Primary)
  );
}
function buildVerifyModal(customId='verify_modal', title='ยืนยันผู้เล่น (PlayFab)'){
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
function buildUserEmbed({ discordId, discordName, playFabId, playerName }){
  return new EmbedBuilder()
    .setTitle('ยืนยันผ่าน')
    .setColor(0x2ecc71)
    .addFields(
      { name:'ไอดีเกม', value: playFabId || '—', inline:false },
      { name:'ชื่อผู้เล่น', value: playerName || '—', inline:false },
      { name:'ไอดี Discord', value: discordId, inline:true },
      { name:'ชื่อ Discord', value: discordName || '—', inline:true }
    ).setTimestamp();
}
function buildFailEmbed(playFabId){
  return new EmbedBuilder()
    .setTitle('ไม่ผ่านการยืนยัน')
    .setDescription(`เราไม่พบ **${playFabId}** ในระบบ โปรดตรวจสอบและลองใหม่อีกครั้ง`)
    .setColor(0xe74c3c)
    .setTimestamp();
}

// ===== Slash Commands =====
const commands = [
  // /send-form = แอดมินเท่านั้น (ตรวจสิทธิ์ใน handler และล็อกไม่ให้ใครเพิ่มบอทโดยนโยบายฝั่ง Portal)
  new SlashCommandBuilder().setName('send-form').setDescription('ส่งฟอร์มยืนยันผู้เล่น (แอดมินเท่านั้น)').setDMPermission(true),
  new SlashCommandBuilder().setName('show').setDescription('ดูข้อมูลของคุณ').setDMPermission(true),
  new SlashCommandBuilder().setName('edit').setDescription('แก้ไข ID เกมของคุณ').addStringOption(o=>o.setName('playerid').setDescription('ไอดีใหม่ (PlayFabId)').setRequired(true)).setDMPermission(true),
  new SlashCommandBuilder().setName('py-info').setDescription('แสดงข้อมูลผู้เล่น (ตรวจบทบาทใน Server A)').addStringOption(o=>o.setName('playerid').setDescription('PlayFabId').setRequired(true)).setDMPermission(true),
  new SlashCommandBuilder().setName('admin-show').setDescription('ดูข้อมูลผู้ใช้ (ตรวจบทบาทใน Server A)').addStringOption(o=>o.setName('discord_name').setDescription('ชื่อ Discord เช่น user#1234').setRequired(true)).setDMPermission(true),
  new SlashCommandBuilder().setName('admin-edit').setDescription('แก้ไขข้อมูลผู้ใช้ (ตรวจบทบาทใน Server A)').addStringOption(o=>o.setName('discord_name').setDescription('ชื่อ Discord').setRequired(true)).addStringOption(o=>o.setName('playerid').setDescription('ไอดีเกมใหม่ (PlayFabId)').setRequired(true)).setDMPermission(true)
].map(c=>c.toJSON());

async function registerCommands(){
  const rest = new REST({ version:'10' }).setToken(TOKEN);
  // Global (ใช้ได้ใน DM และทุกที่ที่อนุญาต)
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('✅ Global commands registered');
}

// ===== Events =====
client.once(Events.ClientReady, async ()=>{
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (i)=>{
  try{
    if (i.isChatInputCommand()){
      const name = i.commandName;

      if (name === 'send-form'){
        const ok = await isAdminInPrimaryGuild(i.user.id);
        if (!ok) return i.reply({ content: '❌ คำสั่งนี้สำหรับแอดมินในเซิร์ฟเวอร์หลักเท่านั้น', ephemeral: true });
        // ส่ง embed + ปุ่ม
        await i.reply({ embeds:[buildFormEmbed()], components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_verify_modal').setLabel('ไอดีของคุณ').setStyle(ButtonStyle.Primary))], ephemeral: !i.guild });
        return;
      }

      if (name === 'show'){
        const doc = await Verify.findOne({ discordId: i.user.id });
        if (!doc) return i.reply({ content:'❌ ยังไม่มีข้อมูลของคุณ', ephemeral:true });
        return i.reply({ embeds:[buildUserEmbed(doc)], ephemeral:true });
      }

      if (name === 'edit'){
        const pid = i.options.getString('playerid', true).trim();
        const info = await getAccountInfoByPlayFabId(pid);
        if (!info.found) return i.reply({ embeds:[buildFailEmbed(pid)], ephemeral:true });
        await Verify.findOneAndUpdate(
          { discordId: i.user.id },
          { discordId: i.user.id, discordName: i.user.tag || i.user.username, playFabId: pid, playerName: info.displayName || info.username || null },
          { upsert:true, new:true }
        );
        return i.reply({ content:`✅ อัปเดตเป็น ${info.displayName || info.username || '—'}`, ephemeral:true });
      }

      if (name === 'py-info'){
        const ok = await isAdminInPrimaryGuild(i.user.id);
        if (!ok) return i.reply({ content:'❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral:true });
        const pid = i.options.getString('playerid', true);
        const info = await getAccountInfoByPlayFabId(pid);
        if (!info.found) return i.reply({ content:'❌ ไม่พบผู้เล่น', ephemeral:true });
        const embed = new EmbedBuilder().setTitle('ข้อมูลผู้เล่น (Server A)').addFields(
          { name:'ไอดีเกม', value: pid, inline:true },
          { name:'ชื่อผู้เล่น', value: info.displayName || info.username || '—', inline:true }
        ).setColor(0x00a8ff).setTimestamp();
        return i.reply({ embeds:[embed], ephemeral:true });
      }

      if (name === 'admin-show'){
        const ok = await isAdminInPrimaryGuild(i.user.id);
        if (!ok) return i.reply({ content:'❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral:true });
        const dname = i.options.getString('discord_name', true);
        const doc = await Verify.findOne({ discordName: dname });
        if (!doc) return i.reply({ content:'❌ ไม่พบข้อมูลของผู้ใช้ชื่อนี้', ephemeral:true });
        return i.reply({ embeds:[buildUserEmbed(doc)], ephemeral:true });
      }

      if (name === 'admin-edit'){
        const ok = await isAdminInPrimaryGuild(i.user.id);
        if (!ok) return i.reply({ content:'❌ คุณไม่มีบทบาทแอดมินในเซิร์ฟเวอร์หลัก', ephemeral:true });
        const dname = i.options.getString('discord_name', true);
        const newPid = i.options.getString('playerid', true);
        const info = await getAccountInfoByPlayFabId(newPid);
        if (!info.found) return i.reply({ embeds:[buildFailEmbed(newPid)], ephemeral:true });
        const updated = await Verify.findOneAndUpdate(
          { discordName: dname },
          { playFabId: newPid, playerName: info.displayName || info.username || null },
          { new:true }
        );
        if (!updated) return i.reply({ content:'❌ ไม่พบผู้ใช้', ephemeral:true });
        return i.reply({ content:`✅ อัปเดต ${dname} เป็น ${updated.playerName || '—'}`, embeds:[buildUserEmbed(updated)], ephemeral:true });
      }
    }

    if (i.isButton()){
      if (i.customId === 'open_verify_modal'){
        // แสดงโมดอล
        return i.showModal(buildVerifyModal());
      }
    }

    if (i.type === InteractionType.ModalSubmit){
      if (i.customId === 'verify_modal'){
        const pfId = i.fields.getTextInputValue('playfab_id').trim();
        await i.deferReply({ ephemeral:true });
        const info = await getAccountInfoByPlayFabId(pfId);
        if (!info.found){
          const fail = buildFailEmbed(pfId);
          try { await i.user.send({ embeds:[fail] }); } catch {}
          return i.editReply({ embeds:[fail] });
        }
        const doc = await Verify.findOneAndUpdate(
          { discordId: i.user.id },
          { discordId: i.user.id, discordName: i.user.tag || i.user.username, playFabId: pfId, playerName: info.displayName || info.username || null },
          { upsert:true, new:true }
        );
        const success = buildUserEmbed(doc);
        try { await i.user.send({ embeds:[success] }); } catch {}
        await logToPrimaryGuild(success);
        return i.editReply({ content:'บันทึกข้อมูลและยืนยันสำเร็จ ✅', embeds:[success] });
      }
    }
  }catch(e){
    console.error('Interaction error:', e);
    if (i.isRepliable()) { try { await i.reply({ content:'เกิดข้อผิดพลาดภายในระบบ', ephemeral:true }); } catch {} }
  }
});

// ===== Health server =====
const app = express();
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.status(200).json({ status:'ok', time:new Date().toISOString() }));
app.listen(PORT, ()=> console.log('HTTP health server on', PORT));

// ===== Bootstrap =====
(async ()=>{
  try{
    await mongoose.connect(MONGO_URI);
    console.log('✅ Mongo connected');
    const ok = await ensurePlayFabLogin();
    if (!ok) throw new Error('PlayFab login failed');
    console.log('✅ PlayFab session ready');
    await client.login(TOKEN);
  }catch(e){
    console.error('Startup error:', e);
    process.exit(1);
  }
})();


แก้ให้แล้วครับ! สาเหตุคือมีขึ้นบรรทัดใหม่จริง ๆ ภายในสตริงของ .setDescription(...) ทำให้ Node (ESM) เจอ Invalid or unexpected token.

ผมอัปเดตโค้ดในแคนวาสให้เรียบร้อย โดยเปลี่ยนบรรทัดนั้นให้ใช้ \n (เขียนเป็น \\n ในไฟล์เพื่อให้ได้ \n จริงตอนรัน) ดังนี้:

.setDescription('กดปุ่ม **ไอดีของคุณ** เพื่อกรอก **PlayFabId**\\nตัวอย่าง: `25CDF5286DC38DAD`')

วิธีทดสอบสั้น ๆ

1. commit/push โค้ดล่าสุด


2. กด Redeploy บน Render


3. ดู log ควรผ่านจุดนี้ได้และไปต่อจนขึ้น:

✅ Mongo connected

✅ PlayFab session ready

🤖 Logged in as <BotName>

HTTP health server on <PORT>




ถ้ายังมี error อื่น ๆ โผล่มาอีก (เช่น import, perms, intents) แปะ log มาได้เลย ผมจะช่วยแก้ให้ต่อจนรันนิ่งครับ 💪

