// Читає останні повідомлення з каналів Discord бот-токеном і пише news.json.
// Запускається GitHub Actions за розкладом; токен — лише в секретах.
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const GUILD_ID = '1298214487156985866'
// Порядок = порядок вкладок у лаунчері
const CHANNEL_IDS = ['1352317487194308741', '1420690955467751475']
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

const FORUM_TYPES = new Set([15, 16]) // GUILD_FORUM, GUILD_MEDIA
const POSTS_PER_FORUM = 24
// Скільки відповідей поста класти в JSON (найновіші); решту — «відкрити в Discord»
const REPLIES_PER_POST = 20

const toMessage = (m, channelId) => ({
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
	embeds: (m.embeds ?? []).map((e) => ({
		title: e.title ?? null,
		description: e.description ?? null,
		url: e.url ?? null,
		image: e.image?.url ?? e.thumbnail?.url ?? null,
	})),
	url: `https://discord.com/channels/${GUILD_ID}/${channelId}/${m.id}`,
})

// Форум: пости = треди; активні беремо з гільдії, архівні — зі списку каналу.
// Обкладинка поста — його перше повідомлення (id збігається з id треду).
const fetchForumPosts = async (channel) => {
	const active = await api(`/guilds/${GUILD_ID}/threads/active`)
	let threads = active.threads.filter((t) => t.parent_id === channel.id)
	let before = null
	while (threads.length < POSTS_PER_FORUM) {
		const page = await api(
			`/channels/${channel.id}/threads/archived/public?limit=50${before ? `&before=${before}` : ''}`,
		)
		threads.push(...page.threads)
		if (!page.has_more || !page.threads.length) break
		before = page.threads.at(-1).thread_metadata.archive_timestamp
	}
	threads = threads
		.sort((a, b) => (b.thread_metadata?.create_timestamp ?? '').localeCompare(a.thread_metadata?.create_timestamp ?? ''))
		.slice(0, POSTS_PER_FORUM)
	const tags = new Map((channel.available_tags ?? []).map((t) => [t.id, t.name]))
	const posts = []
	for (const t of threads) {
		let starter = null
		let replies = []
		try {
			starter = await api(`/channels/${t.id}/messages/${t.id}`)
			// Відповіді — усе після стартового повідомлення, у хронологічному порядку
			const raw = await api(`/channels/${t.id}/messages?limit=${REPLIES_PER_POST}`)
			replies = raw
				.filter((m) => m.id !== t.id && (m.type === 0 || m.type === 19))
				.filter((m) => m.content || m.attachments?.length || m.embeds?.length)
				.reverse()
				.map((m) => toMessage(m, t.id))
		} catch (e) {
			console.warn(`  пост «${t.name}»: без обкладинки (${e.message.split(String.fromCharCode(10))[0]})`)
		}
		posts.push({
			id: t.id,
			title: t.name,
			tags: (t.applied_tags ?? []).map((id) => tags.get(id)).filter(Boolean),
			message_count: t.message_count ?? 0,
			created_at: t.thread_metadata?.create_timestamp ?? starter?.timestamp ?? null,
			url: `https://discord.com/channels/${GUILD_ID}/${t.id}`,
			starter: starter ? toMessage(starter, t.id) : null,
			replies,
		})
	}
	return posts
}

const channels = []
for (const id of CHANNEL_IDS) {
	const channel = await api(`/channels/${id}`)
	if (FORUM_TYPES.has(channel.type)) {
		const posts = await fetchForumPosts(channel)
		channels.push({
			id,
			name: channel.name,
			topic: channel.topic ?? null,
			kind: 'forum',
			url: `https://discord.com/channels/${GUILD_ID}/${id}`,
			messages: [],
			posts,
		})
		console.log(`#${channel.name}: ${posts.length} постів (форум)`)
		continue
	}
	const raw = await api(`/channels/${id}/messages?limit=${MESSAGES_PER_CHANNEL}`)
	const messages = raw
		// Системні повідомлення (pin, join) і порожні без вкладень/ембедів пропускаємо
		.filter((m) => m.type === 0 || m.type === 19)
		.filter((m) => m.content || m.attachments?.length || m.embeds?.length)
		.map((m) => toMessage(m, id))
	channels.push({
		id,
		name: channel.name,
		topic: channel.topic ?? null,
		kind: 'text',
		url: `https://discord.com/channels/${GUILD_ID}/${id}`,
		messages,
		posts: [],
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
