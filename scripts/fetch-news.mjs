// Читає останні повідомлення з каналів Discord бот-токеном і пише news.json.
// Запускається GitHub Actions за розкладом; токен — лише в секретах.
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const GUILD_ID = '1114276509146959982'
// Порядок = порядок вкладок у лаунчері
const CHANNEL_IDS = ['1256213928283734049', '1284175717491282002', '1398078937007132834']
const MESSAGES_PER_CHANNEL = 15
const OUT = 'news.json'

if (!TOKEN) {
	console.error('DISCORD_BOT_TOKEN не заданий')
	process.exit(1)
}

const api = async (path) => {
	const res = await fetch(`https://discord.com/api/v10${path}`, {
		headers: { Authorization: `Bot ${TOKEN}`, 'User-Agent': 'TerrariumNews (github.com/Kemzino/TerrariumNews, 1.0)' },
	})
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
	return res.json()
}

const avatarUrl = (author) =>
	author.avatar
		? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`
		: `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(author.id) >> 22n) % 6}.png`

const channels = []
for (const id of CHANNEL_IDS) {
	const channel = await api(`/channels/${id}`)
	const raw = await api(`/channels/${id}/messages?limit=${MESSAGES_PER_CHANNEL}`)
	const messages = raw
		// Системні повідомлення (pin, join) і порожні без вкладень/ембедів пропускаємо
		.filter((m) => m.type === 0 || m.type === 19)
		.filter((m) => m.content || m.attachments?.length || m.embeds?.length)
		.map((m) => ({
			id: m.id,
			author: m.member?.nick || m.author.global_name || m.author.username,
			avatar: avatarUrl(m.author),
			content: m.content ?? '',
			timestamp: m.timestamp,
			edited_timestamp: m.edited_timestamp ?? null,
			attachments: (m.attachments ?? []).map((a) => ({
				url: a.url,
				name: a.filename,
				content_type: a.content_type ?? null,
				width: a.width ?? null,
				height: a.height ?? null,
			})),
			// Ембеди (посилання з превʼю) — лише заголовок/опис/картинка
			embeds: (m.embeds ?? []).map((e) => ({
				title: e.title ?? null,
				description: e.description ?? null,
				url: e.url ?? null,
				image: e.image?.url ?? e.thumbnail?.url ?? null,
			})),
			url: `https://discord.com/channels/${GUILD_ID}/${id}/${m.id}`,
		}))
	channels.push({
		id,
		name: channel.name,
		topic: channel.topic ?? null,
		url: `https://discord.com/channels/${GUILD_ID}/${id}`,
		messages,
	})
	console.log(`#${channel.name}: ${messages.length} повідомлень`)
}

const next = { channels }
// Не переписуємо файл, якщо змінилась лише мітка часу — інакше cron спамить комітами
if (existsSync(OUT)) {
	const prev = JSON.parse(readFileSync(OUT, 'utf8'))
	if (JSON.stringify(prev.channels) === JSON.stringify(next.channels)) {
		console.log('Без змін')
		process.exit(0)
	}
}
writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), ...next }, null, '\t') + '\n')
console.log('news.json оновлено')
