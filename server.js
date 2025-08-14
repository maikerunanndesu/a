import Discord, { Client, GatewayIntentBits, ChannelType, ApplicationCommandOptionType, EmbedBuilder, WebhookClient, ActivityType } from "discord.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import express from "express";
import 'dotenv/config';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================================================================================================
// 初期設定とクライアントの初期化
// ================================================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// グローバル/クライアントのエラーハンドラを追加（デプロイ先での原因特定用）
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] UnhandledRejection:`, reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] UncaughtException:`, err);
});
client.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] ClientError:`, err);
});
client.on('shardError', (err) => {
  console.error(`[${new Date().toISOString()}] ShardError:`, err);
});

const cacheWebhooks = new Map();
const trmsgid = {}; // 翻訳メッセージIDのキャッシュ
const settingsFilePath = path.join(__dirname, ".data", "settings.json");

// 環境変数
const {
  DISCORD_BOT_TOKEN,
  DEEPL_API_KEY
} = process.env;
const DEEPL_API_URL = process.env.DEEPL_API_URL || "https://api-free.deepl.com/v2/translate";
const DEEPL_USAGE_API_URL = process.env.DEEPL_API_URL
  ? process.env.DEEPL_API_URL.replace("/translate", "/usage")
  : "https://api-free.deepl.com/v2/usage";

// メモリ上で管理する設定キャッシュ
let cash = {};
let DEEPL_CHARACTER_LIMIT = 500000; // デフォルト値

const commands = [
  {
    name: "ping",
    description: "ping値を返します。"
  },
  {
    name: "automatictranslation",
    description: "コマンドが送信されたチャンネルで自動翻訳を開始/停止します。"
  },
  {
    name: "setvoicemonitor",
    description: "特定のボイスチャンネルの監視と通知チャンネルを設定します。",
    options: [
      {
        name: "voice_channel",
        description: "監視するボイスチャンネル",
        type: ApplicationCommandOptionType.Channel,
        channelTypes: [ChannelType.GuildVoice],
        required: true
      },
      {
        name: "notification_channel",
        description: "通知を送信するテキストチャンネル",
        type: ApplicationCommandOptionType.Channel,
        channelTypes: [ChannelType.GuildText],
        required: true
      }
    ]
  },
  {
    name: "stopvoicemonitor",
    description: "ボイスチャンネルの監視を停止します。"
  },
  {
    name: "deeplstatus",
    description: "DeepL APIの現在の使用状況を表示します。"
  }
];

const GUILD_IDS = ["1051299908541501450", "1385222148892655646"];

async function saveSettings() {
  try {
    await fs.writeFile(settingsFilePath, JSON.stringify(cash, null, 2), 'utf8');
    console.log(`[${new Date().toISOString()}] settings.json にキャッシュの状態を保存しました。内容:`, cash);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] settings.json の保存中にエラーが発生しました:`, err);
  }
}

async function loadSettings() {
  try {
    await fs.mkdir(path.join(__dirname, ".data"), { recursive: true });
    await fs.access(settingsFilePath);
  } catch (error) {
    // ファイルが存在しない場合
    const initialSettings = {
      trst: 0,
      msgch: 0,
      voiceMonitorChannelId: null,
      voiceNotificationChannelId: null,
      voiceChannelMembers: {},
      deeplUsageCount: 0,
      deeplLastResetDate: new Date().toISOString().slice(0, 7),
      deeplUsageWarningSent: false
    };
    await fs.writeFile(settingsFilePath, JSON.stringify(initialSettings, null, 2), 'utf8');
    console.log(`[${new Date().toISOString()}] settings.json が存在しないため、初期設定で作成しました。内容:`, initialSettings);
  }

  try {
    const data = await fs.readFile(settingsFilePath, 'utf8');
    cash = JSON.parse(data);
    console.log(`[${new Date().toISOString()}] settings.json を読み込み、キャッシュを設定しました。内容:`, cash);

    const currentMonth = new Date().toISOString().slice(0, 7);
    if (cash.deeplLastResetDate !== currentMonth) {
      console.log(`[${new Date().toISOString()}] DeepLの使用状況をリセットします。`);
      cash.deeplUsageCount = 0;
      cash.deeplLastResetDate = currentMonth;
      cash.deeplUsageWarningSent = false;
      await saveSettings();
    }
    if (typeof cash.deeplUsageWarningSent === 'undefined') {
      cash.deeplUsageWarningSent = false;
      await saveSettings();
    }

    // Bot起動時に監視VCが設定されている場合、メンバーリストを初期化
    if (cash.voiceMonitorChannelId) {
      try {
        const voiceChannel = await client.channels.fetch(cash.voiceMonitorChannelId);
        if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
          const currentMembers = {};
          voiceChannel.members.forEach(member => {
            currentMembers[member.id] = Date.now();
          });
          cash.voiceChannelMembers = currentMembers;
          console.log(`[${new Date().toISOString()}] ボット起動時、監視VC(${voiceChannel.name})の既存メンバーをキャッシュしました。`);
          await saveSettings(); // 初期キャッシュを保存
        } else {
          // VCが見つからない場合やタイプが異なる場合は設定をリセット
          console.warn(`[${new Date().toISOString()}] ボット起動時、設定された監視VC(${cash.voiceMonitorChannelId})が見つからないか、ボイスチャンネルではありません。設定をリセットします。`);
          cash.voiceMonitorChannelId = null;
          cash.voiceNotificationChannelId = null;
          cash.voiceChannelMembers = {};
          await saveSettings();
        }
      } catch (err) {
        console.warn(`[${new Date().toISOString()}] ボット起動時、監視VC(${cash.voiceMonitorChannelId})のメンバー取得に失敗。設定をリセットします。`, err);
        cash.voiceMonitorChannelId = null;
        cash.voiceNotificationChannelId = null;
        cash.voiceChannelMembers = {};
        await saveSettings();
      }
    } else {
      // 監視VCが設定されていない場合でも、voiceChannelMembersは空であることを保証
      if (!cash.voiceChannelMembers) {
        cash.voiceChannelMembers = {};
        await saveSettings();
      }
    }

  } catch (err) {
    console.error(`[${new Date().toISOString()}] settings.json の読み込みエラー。デフォルト設定で起動します。`, err);
    cash = {
      trst: 0,
      msgch: 0,
      voiceMonitorChannelId: null,
      voiceNotificationChannelId: null,
      voiceChannelMembers: {},
      deeplUsageCount: 0,
      deeplLastResetDate: new Date().toISOString().slice(0, 7),
      deeplUsageWarningSent: false
    };
  }
}

// ================================================================================================
// クライアントイベント
// ================================================================================================

client.on("ready", async () => {
  console.log(`[${new Date().toISOString()}] ${client.user.tag}としてログインしました`);
  client.user.setPresence({ status: "online", activities: [{ name: "翻訳", type: ActivityType.Watching }] });

  await loadSettings(); // 修正された loadSettings を呼び出し

  setInterval(saveSettings, 300000);

  if (DEEPL_API_KEY) {
    // DeepL API usage check のロジックはここには含めませんが、必要であれば DeepLStatus のように実装
  }

  try {
    for (const guildId of GUILD_IDS) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        await guild.commands.set(commands);
        console.log(`[${new Date().toISOString()}] スラッシュコマンドをサーバー ${guildId} に登録しました。`);
      } else {
        console.warn(`[${new Date().toISOString()}] ギルド ${guildId} がキャッシュに見つかりません。コマンドを登録できませんでした。`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] スラッシュコマンドの登録に失敗しました:`, err);
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!cash.voiceMonitorChannelId || !cash.voiceNotificationChannelId) {
    return;
  }

  const monitoredVoiceChannelId = cash.voiceMonitorChannelId;
  const notificationTextChannelId = cash.voiceNotificationChannelId;

  const member = newState.member;
  const userId = member.id;
  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  const notificationChannel = await client.channels.fetch(notificationTextChannelId).catch(console.error);
  if (!notificationChannel || notificationChannel.type !== Discord.ChannelType.GuildText) {
    console.error(`[${new Date().toISOString()}] 通知テキストチャンネルが見つからないか、テキストチャンネルではありません: ${notificationTextChannelId}`);
    return;
  }

  if (!cash.voiceChannelMembers) {
    cash.voiceChannelMembers = {};
  }

  const voiceChannel = await client.channels.fetch(monitoredVoiceChannelId);
  if (voiceChannel && voiceChannel.type === Discord.ChannelType.GuildVoice) {
    if (newChannelId === monitoredVoiceChannelId && oldChannelId !== monitoredVoiceChannelId) {
      if (newState.channel && newState.channel.members.size === 1) {
        const embed = new EmbedBuilder()
          .setTitle("🎙️ ボイスチャンネルに人が来ました！")
          .setColor("#00FF00")
          .setDescription(`**${member.displayName}** さんが <#${monitoredVoiceChannelId}> に参加しました。`)
          .addFields(
            { name: "参加時刻", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
          )
          .setTimestamp();
        await notificationChannel.send({ embeds: [embed] }).catch(console.error);
        console.log(`[${new Date().toISOString()}] 参加通知を送信しました。`);
      }
      cash.voiceChannelMembers[userId] = Date.now();

      try {
        const currentSettings = await fs.readFile(settingsFilePath, 'utf8');
        const settings = JSON.parse(currentSettings);
        settings.voiceChannelMembers = cash.voiceChannelMembers;
        await fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
        console.log(`[${new Date().toISOString()}] settings.json にメンバー参加情報を保存しました。`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] メンバー参加情報のsettings.json保存中にエラー:`, err);
      }
    } else if (oldChannelId === monitoredVoiceChannelId && newChannelId !== monitoredVoiceChannelId) {
      console.log(`[${new Date().toISOString()}] ${member.user.tag} が監視VCから退出しました (${oldChannelId})`);

      const joinTime = cash.voiceChannelMembers[userId];
      const leaveTime = Date.now();
      let totalCallDuration = "不明";

      if (joinTime) {
        const durationMs = leaveTime - joinTime;
        const hours = Math.floor(durationMs / (1000 * 60 * 60));
        const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((durationMs % (1000 * 60)) / 1000);
        totalCallDuration = `${hours}時間 ${minutes}分 ${seconds}秒`;
      }

      delete cash.voiceChannelMembers[userId];

      try {
        const currentSettings = await fs.readFile(settingsFilePath, 'utf8');
        const settings = JSON.parse(currentSettings);
        delete settings.voiceChannelMembers[userId];
        await fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
        console.log(`[${new Date().toISOString()}] settings.json からメンバー退出情報を削除しました。`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] メンバー退出情報のsettings.json削除中にエラー:`, err);
      }

      const remainingMembersCollection = await getVoiceChannelMembers(monitoredVoiceChannelId);
      console.log(`[${new Date().toISOString()}] 監視VCの現在のメンバー数: ${remainingMembersCollection.size}`);

      if (remainingMembersCollection.size === 0) {
        const embed = new EmbedBuilder()
          .setTitle("🔇 ボイスチャンネルから誰もいなくなりました。")
          .setColor("#FF0000")
          .setDescription(`**${member.displayName}** さんが <#${monitoredVoiceChannelId}> から退出しました。`)
          .addFields(
            { name: "最後に退出した人", value: member.displayName, inline: true },
            { name: "退出時刻", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
            { name: "合計の通話時間", value: totalCallDuration, inline: false }
          )
          .setTimestamp();
        await notificationChannel.send({ embeds: [embed] }).catch(console.error);
        console.log(`[${new Date().toISOString()}] 最後の退出通知を送信しました。`);
      } else {
        console.log(`[${new Date().toISOString()}] ${member.user.tag} が監視VCから退出しましたが、まだメンバーがいます。`);
      }
    } else if (newChannelId === monitoredVoiceChannelId && oldChannelId === monitoredVoiceChannelId) {
      console.log(`[${new Date().toISOString()}] ${member.user.tag} が監視VC内で状態を変更しました (ミュート/デフなど)。`);
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  if (message.content === "v!start") {
    cash.trst = 1;
    cash.msgch = message.channel.id;
    await saveSettings();
    await message.reply("このチャンネルでの自動翻訳を**開始**しました。 (v!start)");
    return;
  }
  if (message.content === "v!stop") {
    cash.trst = 0;
    cash.msgch = 0;
    await saveSettings();
    await message.reply("このチャンネルでの自動翻訳を**停止**しました。 (v!stop)");
    return;
  }

  const excludePrefixes = ["v!", "m!"];
  if (excludePrefixes.some(p => message.content.startsWith(p))) return;

  if (cash.trst !== 1 || message.channel.id !== cash.msgch) return;

  let trtext = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!trtext || /^([\p{Emoji}\s]|<a?:\w+:\d+>)+$/u.test(trtext)) {
    console.log(`[${new Date().toISOString()}] 翻訳対象外のメッセージ（空または絵文字のみ）: "${message.content}"`);
    return;
  }

  const webhook = await getWebhookInChannel(message.channel);
  if (!webhook) {
    console.error(`[${new Date().toISOString()}] Webhookの取得/作成に失敗しました。チャンネル: ${message.channel.id}`);
    return;
  }

  try {
    let jares = "";
    let enres = "";
    let usedDeepL = false;
    let initialDetectedLang = null;

    if (DEEPL_API_KEY) {
      // DeepL文字数制限の警告チェック（翻訳開始前）
      const remainingChars = DEEPL_CHARACTER_LIMIT - cash.deeplUsageCount;
      const warningThreshold = DEEPL_CHARACTER_LIMIT * 0.10; // 10%

      if (remainingChars <= warningThreshold && !cash.deeplUsageWarningSent) {
        const usagePercentage = ((cash.deeplUsageCount / DEEPL_CHARACTER_LIMIT) * 100).toFixed(2);
        const warningEmbed = new EmbedBuilder()
          .setTitle("⚠️ DeepL文字数制限間近警告")
          .setColor("#FFA500") // オレンジ色
          .setDescription(`今月のDeepL APIの残り文字数が少なくなっています。現在 ${cash.deeplUsageCount.toLocaleString()} / ${DEEPL_CHARACTER_LIMIT.toLocaleString()} 文字 (${usagePercentage}%) を使用済みです。`)
          .setFooter({ text: "翻訳機能が制限される可能性があります。" })
          .setTimestamp();

        // 翻訳チャンネルに送信
        await message.channel.send({ embeds: [warningEmbed] });
        cash.deeplUsageWarningSent = true; // 警告を送信済みとしてマーク
        await saveSettings(); // 設定を保存
        console.log(`[${new Date().toISOString()}] DeepL文字数制限警告を送信しました。`);
      }

      const firstTranslateResult = await translateWithDeepL(trtext, "JA");

      if (firstTranslateResult.success) {
        initialDetectedLang = firstTranslateResult.detectedSourceLang;
        const textLength = trtext.length;

        if (initialDetectedLang === "JA") {
          jares = trtext;
          if (DEEPL_CHARACTER_LIMIT - cash.deeplUsageCount >= textLength) {
            const enResult = await translateWithDeepL(trtext, "EN");
            if (enResult.success) {
              enres = enResult.translation;
              // 日本語の場合は2倍カウント
              cash.deeplUsageCount += textLength * 2;
              usedDeepL = true;
            } else {
              console.warn(`[${new Date().toISOString()}] DeepL(JA->EN)翻訳失敗: ${enResult.error}`);
            }
          } else {
            console.warn(`[${new Date().toISOString()}] DeepL文字数制限のためJA->EN翻訳スキップ`);
          }
        } else if (initialDetectedLang === "EN") {
          enres = trtext;
          if (DEEPL_CHARACTER_LIMIT - cash.deeplUsageCount >= textLength) {
            jares = firstTranslateResult.translation;
            cash.deeplUsageCount += textLength;
            usedDeepL = true;
          } else {
            console.warn(`[${new Date().toISOString()}] DeepL文字数制限のためEN->JA翻訳スキップ`);
          }
        } else { // その他の言語の場合
          const estimatedRequiredChars = textLength * 2; // 両方向に翻訳する場合の概算

          if (DEEPL_CHARACTER_LIMIT - cash.deeplUsageCount >= estimatedRequiredChars) {
            jares = firstTranslateResult.translation;
            const enResult = await translateWithDeepL(trtext, "EN");
            if (enResult.success) {
              enres = enResult.translation;
              cash.deeplUsageCount += estimatedRequiredChars;
              usedDeepL = true;
            } else {
              console.warn(`[${new Date().toISOString()}] DeepL(Other->EN)翻訳失敗: ${enResult.error}`);
            }
          } else {
            console.warn(`[${new Date().toISOString()}] DeepL文字数制限のため両方向翻訳スキップ`);
          }
        }
      } else {
        console.warn(`[${new Date().toISOString()}] DeepL初回翻訳(->JA)失敗: ${firstTranslateResult.error}`);
      }
    }

    // DeepL が使用できなかった場合、または不足している翻訳がある場合に Google 翻訳を試みる
    if (!jares && !usedDeepL) {
      console.log(`[${new Date().toISOString()}] DeepLで日本語翻訳が得られなかったためGoogle翻訳を試行 (->JA)`);
      const googleJaResult = await translateWithGoogle(trtext, "ja");
      if (googleJaResult.success) {
        jares = googleJaResult.translation;
        console.log(`[${new Date().toISOString()}] Google翻訳(->JA)成功。`);
      } else {
        console.warn(`[${new Date().toISOString()}] Google翻訳(->JA)失敗: ${googleJaResult.error}`);
      }
    }
    if (!enres && !usedDeepL) {
      console.log(`[${new Date().toISOString()}] DeepLで英語翻訳が得られなかったためGoogle翻訳を試行 (->EN)`);
      const googleEnResult = await translateWithGoogle(trtext, "en");
      if (googleEnResult.success) {
        enres = googleEnResult.translation;
        console.log(`[${new Date().toISOString()}] Google翻訳(->EN)成功。`);
      } else {
        console.warn(`[${new Date().toISOString()}] Google翻訳(->EN)失敗: ${googleEnResult.error}`);
      }
    }

    // 翻訳結果を結合して表示
    let translatedContent = "";
    if (jares && enres && jares !== enres) {
      translatedContent = `🇯🇵 ${jares}\n🇺🇸 ${enres}`;
    } else if (jares) {
      translatedContent = `🇯🇵 ${jares}`;
    } else if (enres) {
      translatedContent = `🇺🇸 ${enres}`;
    } else {
      console.warn(`[${new Date().toISOString()}] 翻訳結果が空です。元のメッセージ: "${trtext}"`);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor("#87a6c4")
      .setDescription(translatedContent)
      .setFooter({ text: `${message.author.username}`, iconURL: message.author.displayAvatarURL() })
      .setTimestamp();

    const sentMessage = await webhook.send({
      username: client.user.username,
      avatarURL: client.user.displayAvatarURL(),
      embeds: [embed]
    });

    trmsgid[message.id] = {
      webhookMessageId: sentMessage.id,
      webhookId: webhook.id,
      originalContent: trtext,
      translatedContent: translatedContent,
      detectedSourceLang: initialDetectedLang
    };
    console.log(`[${new Date().toISOString()}] 翻訳済みメッセージを送信しました。元メッセージID: ${message.id}, WebhookメッセージID: ${sentMessage.id}`);
    if (usedDeepL) {
      await saveSettings();
    }

  } catch (err) {
    console.error(`[${new Date().toISOString()}] 自動翻訳処理中に致命的なエラーが発生しました:`, err);
  }
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (newMessage.author && newMessage.author.bot) return;
  if (!newMessage.guild) return;
  if (oldMessage.content === newMessage.content) return;

  const translatedMsgInfo = trmsgid[newMessage.id];
  if (!translatedMsgInfo) {
    console.log(`[${new Date().toISOString()}] 編集されたメッセージの翻訳情報が見つかりません: ${newMessage.id}`);
    return;
  }

  if (cash.trst !== 1 || newMessage.channel.id !== cash.msgch) return;

  let trtext = newMessage.content.replace(/<@!?\d+>/g, '').trim();
  if (!trtext || /^([\p{Emoji}\s]|<a?:\w+:\d+>)+$/u.test(trtext)) {
    console.log(`[${new Date().toISOString()}] 編集後の翻訳対象外メッセージ（空または絵文字のみ）: "${newMessage.content}"`);
    if (translatedMsgInfo && translatedMsgInfo.webhookMessageId) {
      try {
        const webhook = await client.fetchWebhook(translatedMsgInfo.webhookId);
        if (webhook) {
          await webhook.deleteMessage(translatedMsgInfo.webhookMessageId);
          delete trmsgid[newMessage.id];
          console.log(`[${new Date().toISOString()}] 空または絵文字のみになったため翻訳メッセージを削除: ${translatedMsgInfo.webhookMessageId}`);
        }
      } catch (deleteError) {
        console.error(`[${new Date().toISOString()}] 翻訳メッセージ削除中にエラー:`, deleteError);
      }
    }
    return;
  }

  const webhook = await getWebhookInChannel(newMessage.channel);
  if (!webhook) {
    console.error(`[${new Date().toISOString()}] Webhookの取得/作成に失敗しました。チャンネル: ${newMessage.channel.id}`);
    return;
  }

  try {
    let jares = "";
    let enres = "";
    let usedDeepL = false;
    let newDetectedLang = null;

    if (DEEPL_API_KEY) {
      const firstTranslateResult = await translateWithDeepL(trtext, "JA");
      if (firstTranslateResult.success) {
        newDetectedLang = firstTranslateResult.detectedSourceLang;
        const textLength = trtext.length;

        let currentDeepLCost = 0;
        if (newDetectedLang === "JA") {
          jares = trtext;
          if (DEEPL_CHARACTER_LIMIT - cash.deeplUsageCount >= textLength) {
            const enResult = await translateWithDeepL(trtext, "EN");
            if (enResult.success) {
              enres = enResult.translation;
              currentDeepLCost += textLength * 2;
              usedDeepL = true;
            }
          }
        } else if (newDetectedLang === "EN") {
          enres = trtext;
          if (DEEPL_CHARACTER_LIMIT - cash.deeplUsageCount >= textLength) {
            jares = firstTranslateResult.translation;
            currentDeepLCost += textLength;
            usedDeepL = true;
          }
        } else {
          const estimatedRequiredChars = textLength * 2;

          if (DEEPL_CHARACTER_LIMIT - cash.deeplUsageCount >= estimatedRequiredChars) {
            jares = firstTranslateResult.translation;
            const enResult = await translateWithDeepL(trtext, "EN");
            if (enResult.success) {
              enres = enResult.translation;
              currentDeepLCost += estimatedRequiredChars;
              usedDeepL = true;
            }
          }
        }
        cash.deeplUsageCount += currentDeepLCost;
      }
    }

    if (!jares && !usedDeepL) {
      console.log(`[${new Date().toISOString()}] 編集メッセージ用DeepLで日本語翻訳が得られなかったためGoogle翻訳を試行 (->JA)`);
      const googleJaResult = await translateWithGoogle(trtext, "ja");
      if (googleJaResult.success) {
        jares = googleJaResult.translation;
      } else {
        console.warn(`[${new Date().toISOString()}] 編集メッセージ用Google翻訳(->JA)失敗: ${googleJaResult.error}`);
      }
    }
    if (!enres && !usedDeepL) {
      console.log(`[${new Date().toISOString()}] 編集メッセージ用DeepLで英語翻訳が得られなかったためGoogle翻訳を試行 (->EN)`);
      const googleEnResult = await translateWithGoogle(trtext, "en");
      if (googleEnResult.success) {
        enres = googleEnResult.translation;
      } else {
        console.warn(`[${new Date().toISOString()}] 編集メッセージ用Google翻訳(->EN)失敗: ${googleEnResult.error}`);
      }
    }

    let translatedContent = "";
    if (jares && enres && jares !== enres) {
      translatedContent = `**[JP]** ${jares}\n**[EN]** ${enres}`;
    } else if (jares) {
      translatedContent = `**[JP]** ${jares}`;
    } else if (enres) {
      translatedContent = `**[EN]** ${enres}`;
    } else {
      console.warn(`[${new Date().toISOString()}] 編集後の翻訳結果が空です。元のメッセージ: "${trtext}"`);
      return;
    }

    if (translatedMsgInfo.originalContent === trtext && translatedMsgInfo.translatedContent === translatedContent) {
      console.log(`[${new Date().toISOString()}] 編集されたメッセージ内容と翻訳内容に変更がないためスキップ: ${newMessage.id}`);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor("#3498db")
      .setDescription(translatedContent)
      .setFooter({ text: `Original by ${newMessage.author.username}`, iconURL: newMessage.author.displayAvatarURL() })
      .setTimestamp();

    if (translatedMsgInfo.webhookMessageId) {
      await webhook.editMessage(translatedMsgInfo.webhookMessageId, { embeds: [embed] });
      trmsgid[newMessage.id].originalContent = trtext;
      trmsgid[newMessage.id].translatedContent = translatedContent;
      trmsgid[newMessage.id].detectedSourceLang = newDetectedLang;
      console.log(`[${new Date().toISOString()}] 翻訳済みメッセージを編集しました。元メッセージID: ${newMessage.id}, WebhookメッセージID: ${translatedMsgInfo.webhookMessageId}`);
      if (usedDeepL) {
        await saveSettings();
      }
    } else {
      console.warn(`[${new Date().toISOString()}] 翻訳済みメッセージIDが見つからないため、編集ではなく新規送信を試みます。元メッセージID: ${newMessage.id}`);
      const sentMessage = await webhook.send({
        username: newMessage.author.displayName,
        avatarURL: newMessage.author.displayAvatarURL(),
        embeds: [embed]
      });
      trmsgid[newMessage.id] = {
        webhookMessageId: sentMessage.id,
        webhookId: webhook.id,
        originalContent: trtext,
        translatedContent: translatedContent,
        detectedSourceLang: newDetectedLang
      };
      console.log(`[${new Date().toISOString()}] 翻訳済みメッセージを新規送信しました。(編集できなかったため) 元メッセージID: ${newMessage.id}, WebhookメッセージID: ${sentMessage.id}`);
      if (usedDeepL) {
        await saveSettings();
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] メッセージ編集時の自動翻訳処理中にエラー:`, err);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    if (commandName === "ping") {
      await interaction.deferReply();
      const timestampStart = Date.now();
      const deferTime = Date.now();

      let googleTranslateStart = Date.now();
      let googleApiResponse = "No response";
      try {
        googleApiResponse = await fetch(
          `https://script.google.com/macros/s/AKfycbxFwiLBgah_9OUM3SJQmEkuQcLSjsmQUJ6NqVPVXX6M8BZ10LRTuBvpFcr0jTaulfbLLw/exec?text=test&source=&target=ja`
        ).then((res) => res.text());
        console.log(`[${new Date().toISOString()}] PingコマンドGoogle翻訳API応答受信: ${googleApiResponse.slice(0, 50)}...`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] PingコマンドGoogle翻訳APIアクセス失敗:`, err);
        googleApiResponse = "Error accessing Google translation API.";
      }
      const googleTranslateEnd = Date.now();
      let deeplTranslateStart = Date.now();
      let deeplApiResponse = "DeepL APIキーが設定されていません。";
      if (DEEPL_API_KEY) {
        try {
          const deeplTestResult = await translateWithDeepL("Test message for DeepL", "ja");
          if (deeplTestResult.success) {
            deeplApiResponse = `OK: "${deeplTestResult.translation.slice(0, 50)}..."`;
          } else {
            deeplApiResponse = `Error: ${deeplTestResult.error}`;
          }
        } catch (err) {
          console.error(`[${new Date().toISOString()}] PingコマンドDeepL翻訳APIアクセス失敗:`, err);
          deeplApiResponse = `DeepL APIアクセス失敗: ${err.message}`;
        }
      }
      const deeplTranslateEnd = Date.now();

      let monitoredVoiceChannelName = "未設定";
      let notificationChannelName = "未設定";
      if (cash.voiceMonitorChannelId) {
        try {
          const vc = await client.channels.fetch(cash.voiceMonitorChannelId);
          if (vc && vc.name) {
            monitoredVoiceChannelName = vc.name;
          }
        } catch (err) {
          console.error(`[${new Date().toISOString()}] 監視VCチャンネル情報の取得に失敗:`, err);
          monitoredVoiceChannelName = `取得失敗 (${cash.voiceMonitorChannelId})`;
        }
      }
      if (cash.voiceNotificationChannelId) {
        try {
          const nc = await client.channels.fetch(cash.voiceNotificationChannelId);
          if (nc && nc.name) {
            notificationChannelName = nc.name;
          }
        } catch (err) {
          console.error(`[${new Date().toISOString()}] 通知チャンネル情報の取得に失敗:`, err);
          notificationChannelName = `取得失敗 (${cash.voiceNotificationChannelId})`;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("📶 Ping結果")
        .setColor("#00AAFF")
        .addFields(
          {
            name: "⏱ 応答速度(ms)",
            value: `${deferTime - timestampStart}ms`,
            inline: true
          },
          {
            name: "🌐 Google翻訳APIからの応答速度",
            value: `${googleTranslateEnd - googleTranslateStart}ms`,
            inline: true
          },
          {
            name: "📚 DeepL翻訳APIからの応答速度",
            value: `${deeplTranslateEnd - deeplTranslateStart}ms`,
            inline: true
          },
          {
            name: "🔁 合計",
            value: `${Math.max(googleTranslateEnd, deeplTranslateEnd) - timestampStart}ms`,
            inline: true
          },
          {
            name: "📝 Google APIの翻訳機能プレビュー",
            value: `\`${googleApiResponse.slice(0, 50)}...\``,
            inline: false
          },
          {
            name: "📝 DeepL APIの翻訳機能プレビュー",
            value: `\`${deeplApiResponse}\``,
            inline: false
          },
          {
            name: "🗣️ 監視中のボイスチャンネル",
            value: monitoredVoiceChannelName,
            inline: true
          },
          {
            name: "📢 通知チャンネル",
            value: notificationChannelName,
            inline: true
          }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      console.log(`[${new Date().toISOString()}] Pingコマンド結果を送信しました。`);
    }

    if (commandName === "automatictranslation") {
      await interaction.deferReply();
      if (cash.trst === 1 && cash.msgch === interaction.channel.id) {
        cash.trst = 0;
        cash.msgch = 0;
        await interaction.editReply("このチャンネルでの自動翻訳を**停止**しました。");
      } else {
        cash.trst = 1;
        cash.msgch = interaction.channel.id;
        await interaction.editReply(`このチャンネルでの自動翻訳を**開始**しました。`);
      }
      await saveSettings();
    }

    if (commandName === "setvoicemonitor") {
      await interaction.deferReply();
      const voiceChannel = interaction.options.getChannel("voice_channel");
      const notificationChannel = interaction.options.getChannel("notification_channel");

      cash.voiceMonitorChannelId = voiceChannel.id;
      cash.voiceNotificationChannelId = notificationChannel.id;
      cash.voiceChannelMembers = {}; // 監視開始時にメンバーリストをリセット（これは正しい）

      // 監視開始時に現在のメンバーをキャッシュ
      try {
        const vc = await client.channels.fetch(voiceChannel.id);
        if (vc && vc.type === ChannelType.GuildVoice) {
          vc.members.forEach(member => {
            cash.voiceChannelMembers[member.id] = Date.now();
          });
          console.log(`[${new Date().toISOString()}] 新たに監視を開始したVC(${vc.name})の初期メンバーをキャッシュしました。`);
        }
      } catch (err) {
        console.warn(`[${new Date().toISOString()}] 新たな監視VCの初期メンバーキャッシュ中にエラー:`, err);
      }

      await interaction.editReply(`ボイスチャンネル <#${voiceChannel.id}> の監視を開始し、通知を <#${notificationChannel.id}> に送信します。`);
      await saveSettings();
    }

    if (commandName === "stopvoicemonitor") {
      await interaction.deferReply();
      cash.voiceMonitorChannelId = null;
      cash.voiceNotificationChannelId = null;
      cash.voiceChannelMembers = {};

      await interaction.editReply("ボイスチャンネルの監視を停止しました。");
      await saveSettings();
    }

    if (commandName === "deeplstatus") {
      if (!DEEPL_API_KEY) {
        return interaction.reply({ content: "DeepL APIキーが設定されていません。", ephemeral: true });
      }
      await interaction.deferReply();
      try {
        const response = await fetch(DEEPL_USAGE_API_URL, { headers: { 'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}` } });
        if (!response.ok) throw new Error(`API error: ${response.status}`);

        const data = await response.json();
        const usagePercentage = ((data.character_count / data.character_limit) * 100).toFixed(2);

        const embed = new EmbedBuilder()
          .setTitle("📚 DeepL API 使用状況")
          .setColor("#2C88D9")
          .addFields(
            { name: "使用文字数", value: `${data.character_count.toLocaleString()} / ${data.character_limit.toLocaleString()}` },
            { name: "使用率", value: `${usagePercentage}%` },
            { name: "内部カウンターの使用量", value: `${cash.deeplUsageCount.toLocaleString()} 文字` }
          )
          .setFooter({ text: "情報はDeepL APIから直接取得 & ボット内部でカウント" })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await interaction.editReply(`DeepL API使用状況の取得に失敗しました: \`${error.message}\``);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] interactionCreate処理中にエラーが発生しました:`, err);
    if (interaction && (interaction.replied || interaction.deferred)) {
      try {
        await interaction.followUp({ content: 'コマンドの処理中にエラーが発生しました。', ephemeral: true });
      } catch (e) {
        // ここでさらにエラーが出ても握りつぶす
      }
    } else if (interaction) {
      try {
        await interaction.reply({ content: 'コマンドの処理中にエラーが発生しました。', ephemeral: true });
      } catch (e) {
        // ここでさらにエラーが出ても絶対に握りつぶす
      }
    }
  }
});


// ================================================================================================
// ヘルパー関数
// ================================================================================================

async function translateWithDeepL(text, targetLang) {
  if (!DEEPL_API_KEY) {
    console.error(`[${new Date().toISOString()}] DeepL APIキー未設定で呼び出し: text='${text}', targetLang='${targetLang}'`);
    return { success: false, error: "APIキー未設定" };
  }
  try {
    console.log(`[${new Date().toISOString()}] DeepL API呼び出し開始: text='${text.slice(0, 50)}...', targetLang='${targetLang}'`);
    const response = await fetch(DEEPL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ text, target_lang: targetLang.toUpperCase() }).toString()
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${new Date().toISOString()}] DeepL APIエラー: status=${response.status}, text='${text.slice(0, 50)}...', errorText='${errorText}'`);
      return { success: false, error: `API Error ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    console.log(`[${new Date().toISOString()}] DeepL APIレスポンス成功。`);
    return {
      success: true,
      translation: data.translations[0].text,
      detectedSourceLang: data.translations[0].detected_source_language
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] DeepL API呼び出し例外:`, error);
    return { success: false, error: error.message };
  }
}

async function translateWithGoogle(text, targetLang) {
  const url = `https://script.google.com/macros/s/AKfycbxFwiLBgah_9OUM3SJQmEkuQcLSjsmQUJ6NqVPVXX6M8BZ10LRTuBvpFcr0jTaulfbLLw/exec?text=${encodeURIComponent(text)}&target=${encodeURIComponent(targetLang)}`;
  try {
    console.log(`[${new Date().toISOString()}] Google翻訳API呼び出し開始: text='${text.slice(0, 50)}...', targetLang='${targetLang}'`);
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${new Date().toISOString()}] Google翻訳APIエラー: status=${response.status}, text='${text.slice(0, 50)}...', errorText='${errorText}'`);
      return { success: false, error: `API Error ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    console.log(`[${new Date().toISOString()}] Google翻訳APIレスポンス成功。`);
    if (typeof data.text === 'string') {
      return { success: true, translation: data.text };
    } else if (typeof data === 'string') {
      return { success: true, translation: data };
    } else {
      console.warn(`[${new Date().toISOString()}] Google翻訳APIから予期しないレスポンス形式を受信:`, data);
      return { success: false, error: 'Unexpected response format' };
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Google翻訳API呼び出し例外:`, error);
    return { success: false, error: error.message };
  }
}

async function getWebhookInChannel(channel) {
  if (cacheWebhooks.has(channel.id)) return cacheWebhooks.get(channel.id);
  try {
    const webhooks = await channel.fetchWebhooks();
    const existingWebhook = webhooks.find(wh => wh.owner && wh.owner.id === client.user.id);
    if (existingWebhook) {
      cacheWebhooks.set(channel.id, existingWebhook);
      return existingWebhook;
    }
    const newWebhook = await channel.createWebhook({
      name: `${client.user.username} Translator`,
      avatar: client.user.displayAvatarURL()
    });
    cacheWebhooks.set(channel.id, newWebhook);
    return newWebhook;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Webhookの取得/作成エラー (Ch: ${channel.id}):`, err);
    return null;
  }
}

async function getVoiceChannelMembers(channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.type === Discord.ChannelType.GuildVoice) {
      return channel.members;
    }
    return new Map(); // 空のMapを返す
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ボイスチャンネルメンバー取得エラー:`, error);
    return new Map(); // エラー時も空のMapを返す
  }
}

// ================================================================================================
// サーバー起動
// ================================================================================================

if (!DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKENが設定されていません。");
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(port, () => console.log(`[${new Date().toISOString()}] Webサーバーがポート ${port} で起動しました。`));

// Discord ログインの結果を明示的にログ
const tokenLength = typeof DISCORD_BOT_TOKEN === 'string' ? DISCORD_BOT_TOKEN.length : 0;
console.log(`[${new Date().toISOString()}] Discord ログイン開始。トークン長=${tokenLength}`);

let readyReceived = false;
client.once('ready', () => { readyReceived = true; });

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error(`[${new Date().toISOString()}] Discord ログインに失敗しました:`, err);
  // クリティカルエラー時は終了（Render でも原因がログに残る）
  process.exit(1);
});

setTimeout(() => {
  if (!readyReceived) {
    console.warn(`[${new Date().toISOString()}] 警告: ログイン開始から30秒経過しても ready が受信されていません。トークンの値（余分な空白/引用符/"Bot "の有無）、Gateway への到達性、Intent 設定を確認してください。`);
  }
}, 30000);