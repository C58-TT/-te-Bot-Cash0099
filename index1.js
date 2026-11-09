require("dotenv").config();
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AuditLogEvent,
  MessageFlags,
  ChannelType,
} = require("discord.js");

const { TOKEN } = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

/* ======================= AYARLAR ======================= */
const SPAM_LIMIT = 5; // X mesaj
const SPAM_SURE = 5000; // Y ms içinde
const SPAM_TIMEOUT = 60_000; // 1 dk susturma
const CAPS_MIN_UZUNLUK = 8;
const CAPS_ORAN = 0.7;

// Kendi listenizi buraya ekleyin
const KUFUR_TAM = ["amk", "aq", "mk", "oç", "oc"];
const KUFUR_ICERIR = ["orospu", "piç", "yarrak", "sikik", "siktir", "amına", "amina", "ananı", "anani"];
const LINK_REGEX = /(https?:\/\/|www\.|discord\.gg\/|discord\.com\/invite\/|\b[a-z0-9-]+\.(com|net|org|gg|xyz|io|tk|ly)\b)/i;

/* ======================= YARDIMCI ======================= */
// Sunucu bazlı ayarlar (log kanalı vb.)
const CFG = "./config.json";
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CFG, "utf8"));
} catch {}
const cfgKaydet = () => fs.writeFileSync(CFG, JSON.stringify(config, null, 2));

async function logla(guild, embed) {
  const kanalId = config[guild.id]?.logKanal;
  if (!kanalId) return; // /log kanal ile ayarlanmamışsa log atma
  try {
    const ch = guild.channels.cache.get(kanalId) || (await guild.channels.fetch(kanalId));
    if (ch) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error("Log hatası:", e.message);
  }
}

/* ======================= GUARD AYARLARI ======================= */
const GUARD_OZELLIKLER = {
  spam: "Spam Koruma",
  kufur: "Küfür Koruma",
  link: "Link Koruma",
  caps: "Caps Lock Koruma",
  bot: "Bot Ekleme Koruması",
  kanalsil: "Kanal Silme Koruması",
  kanalac: "Kanal Oluşturma Koruması",
  rolsil: "Rol Silme Koruması",
};
// Varsayılan: hepsi açık
const guardAcik = (gid, k) => config[gid]?.guard?.[k] !== false;

function guardPanel(gid) {
  const keys = Object.keys(GUARD_OZELLIKLER);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🛡️ Guard Paneli")
    .setDescription(
      keys.map((k) => `${guardAcik(gid, k) ? "🟢" : "🔴"} **${GUARD_OZELLIKLER[k]}**`).join("\n") +
        "\n\nAçıp kapatmak için butonlara bas."
    );
  const rows = [];
  for (let n = 0; n < keys.length; n += 4) {
    rows.push(
      new ActionRowBuilder().addComponents(
        keys
          .slice(n, n + 4)
          .map((k) =>
            new ButtonBuilder()
              .setCustomId(`gd_${k}`)
              .setLabel(GUARD_OZELLIKLER[k])
              .setStyle(guardAcik(gid, k) ? ButtonStyle.Success : ButtonStyle.Danger)
          )
      )
    );
  }
  return { embeds: [embed], components: rows };
}

// Denetim kaydından işlemi yapanı bul
async function yetkiliBul(guild, type, hedefId) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    const e = logs.entries.find((x) => x.target?.id === hedefId && Date.now() - x.createdTimestamp < 15000);
    return e?.executor || null;
  } catch {
    return null;
  }
}

// Sunucu sahibi ve botun kendisi dışındaki herkes cezalanır
function sorumluMu(guild, executor) {
  return executor && executor.id !== guild.ownerId && executor.id !== client.user.id;
}

async function cezala(guild, executor, sebep) {
  const m = await guild.members.fetch(executor.id).catch(() => null);
  if (!m) return "Üye bulunamadı";
  if (executor.bot) {
    await m.kick(sebep).catch(() => {});
    return "Bot sunucudan atıldı";
  }
  const ok = await m.roles.set([], sebep).then(() => true).catch(() => false);
  return ok ? "Tüm rolleri alındı" : "Rolleri alınamadı (botun rolü, kişinin rolünden yukarıda olmalı)";
}

function korumaLogu(guild, baslik, executor, detay, ceza) {
  return logla(
    guild,
    new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle(baslik)
      .addFields(
        { name: "İşlemi Yapan", value: `${executor} (\`${executor.id}\`)` },
        { name: "Detay", value: detay },
        { name: "Uygulanan Ceza", value: ceza }
      )
      .setTimestamp()
  );
}

function muaf(member) {
  return (
    !member ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages)
  );
}

function kufurVarMi(metin) {
  const t = metin.toLocaleLowerCase("tr");
  const kelimeler = t.split(/[^a-zçğıöşü0-9]+/i).filter(Boolean);
  if (kelimeler.some((k) => KUFUR_TAM.includes(k))) return true;
  return KUFUR_ICERIR.some((k) => t.includes(k));
}

function capsVarMi(metin) {
  const harfler = metin.replace(/[^a-zA-ZçğıöşüÇĞİÖŞÜ]/g, "");
  if (harfler.length < CAPS_MIN_UZUNLUK) return false;
  const buyuk = harfler.replace(/[^A-ZÇĞİÖŞÜ]/g, "").length;
  return buyuk / harfler.length >= CAPS_ORAN;
}

/* ======================= GUARD: MESAJ ======================= */
const spamMap = new Map();

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  if (muaf(message.member)) return;

  let sebep = null;

  // Spam
  const key = `${message.guild.id}-${message.author.id}`;
  const now = Date.now();
  const liste = (spamMap.get(key) || []).filter((x) => now - x.t < SPAM_SURE);
  liste.push({ t: now, id: message.id, ch: message.channel.id });
  spamMap.set(key, liste);

  if (guardAcik(message.guild.id, "spam") && liste.length >= SPAM_LIMIT) {
    sebep = "Spam";
    // Spam mesajlarını topluca sil
    try {
      const msgs = await message.channel.messages.fetch({ limit: 20 });
      const silinecek = msgs.filter((m) => m.author.id === message.author.id && now - m.createdTimestamp < SPAM_SURE + 2000);
      await message.channel.bulkDelete(silinecek, true);
    } catch {}
    spamMap.delete(key);
    message.member.timeout(SPAM_TIMEOUT, "Spam").catch(() => {});
  } else if (guardAcik(message.guild.id, "link") && LINK_REGEX.test(message.content)) {
    sebep = "Link";
  } else if (guardAcik(message.guild.id, "kufur") && kufurVarMi(message.content)) {
    sebep = "Küfür";
  } else if (guardAcik(message.guild.id, "caps") && capsVarMi(message.content)) {
    sebep = "Caps Lock";
  }

  if (!sebep) return;

  if (sebep !== "Spam") await message.delete().catch(() => {});

  const uyari = await message.channel
    .send(`${message.author}, mesajın **${sebep}** sebebiyle silindi.`)
    .catch(() => null);
  if (uyari) setTimeout(() => uyari.delete().catch(() => {}), 4000);

  await logla(
    message.guild,
    new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(`🛡️ Mesaj Silindi — ${sebep}`)
      .addFields(
        { name: "Kullanıcı", value: `${message.author} (\`${message.author.id}\`)` },
        { name: "Kanal", value: `${message.channel}` },
        { name: "Mesaj", value: (message.content || "—").slice(0, 1000) }
      )
      .setTimestamp()
  );
});

// Düzenleyerek kaçmayı engelle
client.on("messageUpdate", async (_old, message) => {
  if (message.partial) message = await message.fetch().catch(() => null);
  if (!message || !message.guild || message.author?.bot) return;
  if (muaf(message.member)) return;
  let sebep = null;
  if (guardAcik(message.guild.id, "link") && LINK_REGEX.test(message.content)) sebep = "Link";
  else if (guardAcik(message.guild.id, "kufur") && kufurVarMi(message.content)) sebep = "Küfür";
  else if (guardAcik(message.guild.id, "caps") && capsVarMi(message.content)) sebep = "Caps Lock";
  if (!sebep) return;
  await message.delete().catch(() => {});
  await logla(
    message.guild,
    new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(`🛡️ Düzenlenen Mesaj Silindi — ${sebep}`)
      .addFields(
        { name: "Kullanıcı", value: `${message.author} (\`${message.author.id}\`)` },
        { name: "Mesaj", value: (message.content || "—").slice(0, 1000) }
      )
      .setTimestamp()
  );
});

/* ======================= GUARD: BOT EKLEME ======================= */
client.on("guildMemberAdd", async (member) => {
  if (!member.user.bot) return;
  if (!guardAcik(member.guild.id, "bot")) return;
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 });
    const entry = logs.entries.find((e) => e.target?.id === member.id);
    const ekleyen = entry?.executor;

    // Sunucu sahibi ekliyorsa izin ver
    if (ekleyen && ekleyen.id === member.guild.ownerId) return;

    await member.kick("Bot ekleme koruması").catch(() => {});
    await logla(
      member.guild,
      new EmbedBuilder()
        .setColor(0xfaa61a)
        .setTitle("🤖 Bot Ekleme Engellendi")
        .addFields(
          { name: "Bot", value: `${member.user.tag} (\`${member.id}\`)` },
          { name: "Ekleyen", value: ekleyen ? `${ekleyen} (\`${ekleyen.id}\`)` : "Bilinmiyor" }
        )
        .setTimestamp()
    );
  } catch (e) {
    console.error("Bot koruma hatası:", e.message);
  }
});

/* ======================= GUARD: KANAL / ROL ======================= */
client.on("channelDelete", async (channel) => {
  const guild = channel.guild;
  if (!guild || !guardAcik(guild.id, "kanalsil")) return;
  const executor = await yetkiliBul(guild, AuditLogEvent.ChannelDelete, channel.id);
  if (!sorumluMu(guild, executor)) return;

  const ceza = await cezala(guild, executor, "Kanal silme koruması");
  let geri = "Kanal geri oluşturulamadı";
  try {
    const yeni = await channel.clone();
    geri = `Kanal geri oluşturuldu: ${yeni}`;
    if (config[guild.id]?.logKanal === channel.id) {
      config[guild.id].logKanal = yeni.id;
      cfgKaydet();
    }
  } catch {}
  await korumaLogu(guild, "🚨 Kanal Silme Engellendi", executor, `Silinen kanal: **#${channel.name}**\n${geri}`, ceza);
});

client.on("channelCreate", async (channel) => {
  const guild = channel.guild;
  if (!guild || !guardAcik(guild.id, "kanalac")) return;
  const executor = await yetkiliBul(guild, AuditLogEvent.ChannelCreate, channel.id);
  if (!sorumluMu(guild, executor)) return;

  const ceza = await cezala(guild, executor, "Kanal oluşturma koruması");
  const silindi = await channel.delete("Kanal oluşturma koruması").then(() => true).catch(() => false);
  await korumaLogu(
    guild,
    "🚨 Kanal Oluşturma Engellendi",
    executor,
    `Oluşturulan kanal: **#${channel.name}**\n${silindi ? "Kanal silindi" : "Kanal silinemedi"}`,
    ceza
  );
});

client.on("roleDelete", async (role) => {
  const guild = role.guild;
  if (!guardAcik(guild.id, "rolsil")) return;
  const executor = await yetkiliBul(guild, AuditLogEvent.RoleDelete, role.id);
  if (!sorumluMu(guild, executor)) return;

  const ceza = await cezala(guild, executor, "Rol silme koruması");
  let geri = "Rol geri oluşturulamadı";
  try {
    const yeni = await guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions,
      mentionable: role.mentionable,
      reason: "Rol silme koruması",
    });
    await yeni.setPosition(role.position).catch(() => {});
    geri = `Rol geri oluşturuldu: ${yeni}`;
  } catch {}
  await korumaLogu(guild, "🚨 Rol Silme Engellendi", executor, `Silinen rol: **${role.name}**\n${geri}`, ceza);
});

/* ======================= KOMUTLAR ======================= */
const komutlar = [
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Kullanıcıyı sunucudan yasaklar")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName("kullanici").setDescription("Banlanacak kullanıcı").setRequired(true))
    .addStringOption((o) => o.setName("sebep").setDescription("Ban sebebi").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ban-ac")
    .setDescription("Kullanıcının banını kaldırır")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName("kullanici_id").setDescription("Banı açılacak kullanıcının ID'si").setRequired(true))
    .addStringOption((o) => o.setName("sebep").setDescription("Sebep").setRequired(true)),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Kullanıcıyı susturur (timeout)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName("kullanici").setDescription("Susturulacak kullanıcı").setRequired(true))
    .addStringOption((o) => o.setName("sebep").setDescription("Mute sebebi").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("sure").setDescription("Süre (dakika, varsayılan 60, en fazla 40320)").setMinValue(1).setMaxValue(40320)
    ),

  new SlashCommandBuilder()
    .setName("mute-ac")
    .setDescription("Kullanıcının susturmasını kaldırır")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName("kullanici").setDescription("Susturması kalkacak kullanıcı").setRequired(true))
    .addStringOption((o) => o.setName("sebep").setDescription("Sebep").setRequired(true)),

  new SlashCommandBuilder()
    .setName("guard")
    .setDescription("Koruma sistemlerini aç/kapat (sadece sunucu kurucusu)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("log")
    .setDescription("Log kanalını ayarlar (sadece sunucu kurucusu)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) =>
      sc
        .setName("kanal")
        .setDescription("Logların gönderileceği kanalı seç")
        .addChannelOption((o) =>
          o.setName("kanal").setDescription("Log kanalı").addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("dm")
    .setDescription("Sunucudaki herkese DM duyurusu gönderir")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName("mesaj").setDescription("Herkese gönderilecek mesaj").setRequired(true)),

  new SlashCommandBuilder()
    .setName("etkinlik-kur")
    .setDescription("Katılım panelli etkinlik oluşturur")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName("aciklama").setDescription("Etkinlik açıklaması").setRequired(true))
    .addStringOption((o) => o.setName("bilgi").setDescription("Bilgi butonunda görünecek yazı").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("kazanan").setDescription("Ana (main) katılımcı sayısı").setMinValue(1).setMaxValue(100).setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("yedek").setDescription("Yedek katılımcı sayısı").setMinValue(0).setMaxValue(50).setRequired(true)
    ),
].map((c) => c.toJSON());

client.once("clientReady", async () => {
  await client.application.commands.set(komutlar);
  console.log(`${client.user.tag} aktif!`);
});

/* ======================= ETKİNLİK ======================= */
const DB = "./events.json";
let events = {};
try {
  events = JSON.parse(fs.readFileSync(DB, "utf8"));
} catch {}
const kaydet = () => fs.writeFileSync(DB, JSON.stringify(events, null, 2));

function etkinlikEmbed(ev) {
  const dolu = ev.main.length >= ev.kazanan;
  let durum;
  if (ev.iptal) durum = "[ ETKİNLİK İPTAL EDİLDİ ]";
  else if (dolu) durum = `[ MAİN DOLDU! YEDEK: ${ev.yedek.length} / ${ev.yedekLimit} ]`;
  else durum = `[ MAİN: ${ev.main.length} / ${ev.kazanan} ]`;

  let liste = ev.main.map((id, i) => `${i + 1}. <@${id}> \`${id}\``).join("\n") || "*Henüz kimse katılmadı.*";
  if (ev.yedekLimit > 0) {
    liste += "\n\n**~ YEDEKLER ~**\n";
    liste += ev.yedek.map((id, i) => `Y${i + 1}. <@${id}> \`${id}\``).join("\n") || "*Yedek yok.*";
  }

  return new EmbedBuilder()
    .setColor(ev.iptal ? 0x747f8d : 0xed4245)
    .setDescription(`${ev.aciklama}\n\n\`${durum}\``)
    .addFields(
      { name: "SÜRE", value: `<t:${Math.floor(ev.olusturma / 1000)}:R>`, inline: true },
      { name: "Katılımcılar", value: liste.slice(0, 1024) }
    );
}

function butonlar(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ev_katil").setLabel("Katıl").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId("ev_ayril").setLabel("Ayrıl").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId("ev_bilgi").setLabel("Bilgi").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ev_iptal").setLabel("İPTAL ET").setEmoji("⭕").setStyle(ButtonStyle.Secondary).setDisabled(disabled)
  );
}

client.on("interactionCreate", async (i) => {
  try {
    /* ---- Moderasyon: /ban /ban-ac /mute /mute-ac ---- */
    if (i.isChatInputCommand() && ["ban", "ban-ac", "mute", "mute-ac"].includes(i.commandName)) {
      const cmd = i.commandName;
      const gerekli = cmd.startsWith("ban") ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.ModerateMembers;
      if (!i.memberPermissions.has(gerekli))
        return i.reply({ content: "❌ Bu komut için yetkin yok.", flags: MessageFlags.Ephemeral });

      const sebep = i.options.getString("sebep");
      const ephemeral = MessageFlags.Ephemeral;
      let baslik, hedefText, renk, ekstra = null;

      // ID ile ban açma
      if (cmd === "ban-ac") {
        const id = i.options.getString("kullanici_id").trim();
        if (!/^\d{17,20}$/.test(id))
          return i.reply({ content: "❌ Geçerli bir kullanıcı ID'si gir.", flags: ephemeral });
        const ban = await i.guild.bans.fetch(id).catch(() => null);
        if (!ban) return i.reply({ content: "⚠️ Bu kullanıcı banlı değil.", flags: ephemeral });
        await i.guild.bans.remove(id, `${sebep} | ${i.user.tag}`);
        await i.reply({ content: `✅ <@${id}> (\`${id}\`) kullanıcısının banı kaldırıldı.`, flags: ephemeral });
        baslik = "🔓 Ban Kaldırıldı";
        hedefText = `<@${id}> (\`${id}\`)`;
        renk = 0x57f287;
      } else {
        const user = i.options.getUser("kullanici");
        const member = await i.guild.members.fetch(user.id).catch(() => null);

        if (user.id === i.user.id)
          return i.reply({ content: "❌ Kendine işlem yapamazsın.", flags: ephemeral });
        if (user.id === client.user.id || user.id === i.guild.ownerId)
          return i.reply({ content: "❌ Bu kullanıcıya işlem yapılamaz.", flags: ephemeral });

        // Rol hiyerarşisi kontrolü (kurucu muaf)
        if (member && i.user.id !== i.guild.ownerId && member.roles.highest.position >= i.member.roles.highest.position)
          return i.reply({ content: "❌ Rolü senden yüksek veya eşit biriyle işlem yapamazsın.", flags: ephemeral });

        if (cmd === "ban") {
          if (member && !member.bannable)
            return i.reply({ content: "❌ Botun rolü bu kullanıcıyı banlamaya yetmiyor.", flags: ephemeral });
          await i.guild.members.ban(user.id, { reason: `${sebep} | ${i.user.tag}` });
          await i.reply({ content: `🔨 ${user} (\`${user.id}\`) banlandı.\n**Sebep:** ${sebep}`, flags: ephemeral });
          baslik = "🔨 Kullanıcı Banlandı";
          renk = 0xed4245;
        } else if (cmd === "mute") {
          if (!member) return i.reply({ content: "❌ Kullanıcı sunucuda değil.", flags: ephemeral });
          if (!member.moderatable)
            return i.reply({ content: "❌ Bu kullanıcıyı susturamıyorum (yetki/rol sorunu).", flags: ephemeral });
          const dk = i.options.getInteger("sure") || 60;
          await member.timeout(dk * 60 * 1000, `${sebep} | ${i.user.tag}`);
          await i.reply({ content: `🔇 ${user} ${dk} dakika susturuldu.\n**Sebep:** ${sebep}`, flags: ephemeral });
          baslik = "🔇 Kullanıcı Susturuldu";
          renk = 0xfaa61a;
          ekstra = { name: "Süre", value: `${dk} dakika` };
        } else {
          if (!member) return i.reply({ content: "❌ Kullanıcı sunucuda değil.", flags: ephemeral });
          if (!member.isCommunicationDisabled())
            return i.reply({ content: "⚠️ Bu kullanıcı zaten susturulmuş değil.", flags: ephemeral });
          await member.timeout(null, `${sebep} | ${i.user.tag}`);
          await i.reply({ content: `🔊 ${user} kullanıcısının susturması kaldırıldı.`, flags: ephemeral });
          baslik = "🔊 Susturma Kaldırıldı";
          renk = 0x57f287;
        }
        hedefText = `${user} (\`${user.id}\`)`;
      }

      const embed = new EmbedBuilder()
        .setColor(renk)
        .setTitle(baslik)
        .addFields(
          { name: "Kullanıcı", value: hedefText },
          { name: "Yetkili", value: `${i.user} (\`${i.user.id}\`)` },
          { name: "Sebep", value: sebep.slice(0, 1000) }
        )
        .setTimestamp();
      if (ekstra) embed.addFields(ekstra);
      return logla(i.guild, embed);
    }

    /* ---- /guard ---- */
    if (i.isChatInputCommand() && i.commandName === "guard") {
      if (i.user.id !== i.guild.ownerId)
        return i.reply({ content: "❌ Bu komutu sadece sunucu kurucusu kullanabilir.", flags: MessageFlags.Ephemeral });
      return i.reply({ ...guardPanel(i.guild.id), flags: MessageFlags.Ephemeral });
    }

    if (i.isButton() && i.customId.startsWith("gd_")) {
      if (i.user.id !== i.guild.ownerId)
        return i.reply({ content: "❌ Sadece sunucu kurucusu değiştirebilir.", flags: MessageFlags.Ephemeral });
      const k = i.customId.slice(3);
      if (!GUARD_OZELLIKLER[k]) return;
      const g = config[i.guild.id] || (config[i.guild.id] = {});
      g.guard = g.guard || {};
      g.guard[k] = !guardAcik(i.guild.id, k);
      cfgKaydet();
      return i.update(guardPanel(i.guild.id));
    }

    /* ---- /log kanal ---- */
    if (i.isChatInputCommand() && i.commandName === "log") {
      if (i.user.id !== i.guild.ownerId)
        return i.reply({ content: "❌ Bu komutu sadece sunucu kurucusu kullanabilir.", flags: MessageFlags.Ephemeral });

      const kanal = i.options.getChannel("kanal");
      const izin = kanal.permissionsFor(i.guild.members.me);
      if (!izin?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
        return i.reply({
          content: "❌ Bu kanalda mesaj gönderme/embed yetkim yok. Yetki verip tekrar dene.",
          flags: MessageFlags.Ephemeral,
        });

      config[i.guild.id] = { ...(config[i.guild.id] || {}), logKanal: kanal.id };
      cfgKaydet();
      await i.reply({ content: `✅ Log kanalı ${kanal} olarak ayarlandı.`, flags: MessageFlags.Ephemeral });
      return kanal.send("🛡️ Log kanalı başarıyla ayarlandı. Silinen mesajlar ve koruma kayıtları buraya gelecek.").catch(() => {});
    }

    /* ---- /dm ---- */
    if (i.isChatInputCommand() && i.commandName === "dm") {
      if (!i.memberPermissions.has(PermissionFlagsBits.Administrator))
        return i.reply({ content: "❌ Bu komutu sadece yöneticiler kullanabilir.", flags: MessageFlags.Ephemeral });

      // Günde 1 kez kullanım sınırı (sunucu başına, 24 saat)
      const SURE = 24 * 60 * 60 * 1000;
      const son = config[i.guild.id]?.sonDm || 0;
      if (Date.now() - son < SURE) {
        const acilis = Math.floor((son + SURE) / 1000);
        return i.reply({
          content: `⏳ /dm komutu günde sadece 1 kez kullanılabilir. Tekrar kullanabileceğin zaman: <t:${acilis}:R> (<t:${acilis}:f>)`,
          flags: MessageFlags.Ephemeral,
        });
      }
      config[i.guild.id] = { ...(config[i.guild.id] || {}), sonDm: Date.now() };
      cfgKaydet();

      const mesaj = i.options.getString("mesaj");
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      const uyeler = await i.guild.members.fetch();
      const kisiler = uyeler.filter((m) => !m.user.bot);
      await i.editReply(`📨 ${kisiler.size} kişiye gönderim başladı. Bitince sana DM ile rapor vereceğim.`);

      let basarili = 0,
        basarisiz = 0;
      for (const [, m] of kisiler) {
        const ok = await m.send(mesaj).then(() => true).catch(() => false);
        ok ? basarili++ : basarisiz++;
        await new Promise((r) => setTimeout(r, 1200)); // rate limit koruması
      }

      // Büyük sunucularda interaction süresi (15 dk) dolabilir, o yüzden DM ile bildir
      const rapor = `✅ DM duyurusu tamamlandı.\nBaşarılı: **${basarili}** | Başarısız (DM kapalı): **${basarisiz}**`;
      await i.user.send(rapor).catch(() => {});
      return logla(
        i.guild,
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📨 DM Duyurusu")
          .addFields(
            { name: "Gönderen", value: `${i.user}` },
            { name: "Mesaj", value: mesaj.slice(0, 1000) },
            { name: "Sonuç", value: `Başarılı: ${basarili} | Başarısız: ${basarisiz}` }
          )
          .setTimestamp()
      );
    }

    /* ---- /etkinlik-kur ---- */
    if (i.isChatInputCommand() && i.commandName === "etkinlik-kur") {
      if (!i.memberPermissions.has(PermissionFlagsBits.Administrator))
        return i.reply({ content: "❌ Bu komutu sadece yöneticiler kullanabilir.", flags: MessageFlags.Ephemeral });

      const ev = {
        aciklama: i.options.getString("aciklama"),
        bilgi: i.options.getString("bilgi"),
        kazanan: i.options.getInteger("kazanan"),
        yedekLimit: i.options.getInteger("yedek"),
        main: [],
        yedek: [],
        kurucu: i.user.id,
        olusturma: Date.now(),
        iptal: false,
      };
      const msg = await i.reply({ embeds: [etkinlikEmbed(ev)], components: [butonlar()], fetchReply: true });
      events[msg.id] = ev;
      kaydet();
      return;
    }

    /* ---- Butonlar ---- */
    if (i.isButton() && i.customId.startsWith("ev_")) {
      const ev = events[i.message.id];
      if (!ev) return i.reply({ content: "❌ Etkinlik verisi bulunamadı.", flags: MessageFlags.Ephemeral });

      if (i.customId === "ev_bilgi")
        return i.reply({ content: `ℹ️ **Bilgi**\n${ev.bilgi}`, flags: MessageFlags.Ephemeral });

      if (ev.iptal) return i.reply({ content: "❌ Bu etkinlik iptal edildi.", flags: MessageFlags.Ephemeral });

      const id = i.user.id;

      if (i.customId === "ev_katil") {
        if (ev.main.includes(id) || ev.yedek.includes(id))
          return i.reply({ content: "⚠️ Zaten katıldın.", flags: MessageFlags.Ephemeral });
        let cevap;
        if (ev.main.length < ev.kazanan) {
          ev.main.push(id);
          cevap = "✅ Ana listeye katıldın!";
        } else if (ev.yedek.length < ev.yedekLimit) {
          ev.yedek.push(id);
          cevap = "🟡 Ana liste dolu, yedek listeye eklendin.";
        } else {
          return i.reply({ content: "❌ Etkinlik tamamen dolu.", flags: MessageFlags.Ephemeral });
        }
        kaydet();
        await i.update({ embeds: [etkinlikEmbed(ev)] });
        return i.followUp({ content: cevap, flags: MessageFlags.Ephemeral });
      }

      if (i.customId === "ev_ayril") {
        if (ev.main.includes(id)) {
          ev.main = ev.main.filter((x) => x !== id);
          if (ev.yedek.length) ev.main.push(ev.yedek.shift()); // yedekten terfi
        } else if (ev.yedek.includes(id)) {
          ev.yedek = ev.yedek.filter((x) => x !== id);
        } else {
          return i.reply({ content: "⚠️ Zaten listede değilsin.", flags: MessageFlags.Ephemeral });
        }
        kaydet();
        await i.update({ embeds: [etkinlikEmbed(ev)] });
        return i.followUp({ content: "👋 Etkinlikten ayrıldın.", flags: MessageFlags.Ephemeral });
      }

      if (i.customId === "ev_iptal") {
        if (id !== ev.kurucu && !i.memberPermissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "❌ Sadece kurucu veya yönetici iptal edebilir.", flags: MessageFlags.Ephemeral });
        ev.iptal = true;
        kaydet();
        return i.update({ embeds: [etkinlikEmbed(ev)], components: [butonlar(true)] });
      }
    }
  } catch (e) {
    console.error(e);
    if (i.isRepliable() && !i.replied && !i.deferred)
      i.reply({ content: "❌ Bir hata oluştu.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(TOKEN);
