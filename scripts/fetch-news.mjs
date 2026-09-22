// Читає останні повідомлення з каналів Discord бот-токеном і пише news.json.
// Запускається GitHub Actions за розкладом; токен — лише в секретах.
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const TOKEN = process.env.DISCORD_BOT_TOKEN
// TERRARIUM | UA
const GUILD_ID = '1114276509146959982'
// Порядок = порядок вкладок у лаунчері: новини-create, оголошення-create, рп-пости
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

const FORUM_TYPES = new Set([15, 16]) // GUILD_FORUM, GUILD_MEDIA
const POSTS_PER_FORUM = 24
// Скільки відповідей поста класти в JSON (найновіші); решту — «відкрити в Discord»
const REPLIES_PER_POST = 20

// Ролі гільдії (назва, колір, позиція) — для кольору ніка, як у Discord, і для
// згадок <@&id> у тексті. Учасники — за потреби, з кешем на прогін: REST не
// віддає member разом із повідомленням, тож нік і ролі беремо окремим запитом.
const roles = new Map()
const members = new Map()
const channelNames = new Map()
const hexColor = (color) => (color ? `#${color.toString(16).padStart(6, '0')}` : null)

const loadRoles = async () => {
	for (const r of await api(`/guilds/${GUILD_ID}/roles`)) {
		roles.set(r.id, { name: r.name, color: hexColor(r.color), position: r.position })
	}
}

const getMember = async (userId) => {
	if (members.has(userId)) return members.get(userId)
	let info = null
	try {
		const d = await api(`/guilds/${GUILD_ID}/members/${userId}`)
		// Колір ніка — найвища роль із власним кольором
		const top = (d.roles ?? [])
			.map((id) => roles.get(id))
			.filter((r) => r?.color)
			.sort((a, b) => b.position - a.position)[0]
		info = { nick: d.nick ?? null, color: top?.color ?? null }
	} catch {
		// Вийшов із сервера — без ніка й кольору
	}
	members.set(userId, info)
	return info
}

const getChannelName = async (id) => {
	if (channelNames.has(id)) return channelNames.get(id)
	let name = null
	try {
		name = (await api(`/channels/${id}`)).name
	} catch {
		// Канал бот не бачить
	}
	channelNames.set(id, name)
	return name
}

const displayName = (user, member) => member?.nick || user.global_name || user.username

// Що потрібно лаунчеру, щоб показати згадки в тексті словами, а не id
const mentionsOf = async (m) => {
	const users = {}
	for (const u of m.mentions ?? []) {
		users[u.id] = displayName(u, await getMember(u.id))
	}
	const mentionedRoles = {}
	for (const id of m.mention_roles ?? []) {
		const r = roles.get(id)
		if (r) mentionedRoles[id] = { name: r.name, color: r.color }
	}
	const channels = {}
	for (const [, id] of (m.content ?? '').matchAll(/<#(\d+)>/g)) {
		const name = await getChannelName(id)
		if (name) channels[id] = name
	}
	const out = {}
	if (Object.keys(users).length) out.users = users
	if (Object.keys(mentionedRoles).length) out.roles = mentionedRoles
	if (Object.keys(channels).length) out.channels = channels
	return Object.keys(out).length ? out : undefined
}

const toMessage = async (m, channelId) => ({
	id: m.id,
	author: displayName(m.author, m.member ?? (await getMember(m.author.id))),
	author_color: (await getMember(m.author.id))?.color ?? null,
	avatar: avatarUrl(m.author),
	content: m.content ?? '',
	mentions: await mentionsOf(m),
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
			const kept = raw
				.filter((m) => m.id !== t.id && (m.type === 0 || m.type === 19))
				.filter((m) => m.content || m.attachments?.length || m.embeds?.length)
				.reverse()
			replies = []
			for (const m of kept) replies.push(await toMessage(m, t.id))
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
			starter: starter ? await toMessage(starter, t.id) : null,
			replies,
		})
	}
	return posts
}

// Назва без «дерева» з псевдографіки на початку (┌🔆новини-create → 🔆новини-create)
const cleanName = (name) => name.replace(/^[─-╿\s]+/u, '')

await loadRoles()

const channels = []
for (const id of CHANNEL_IDS) {
	const channel = await api(`/channels/${id}`)
	channel.name = cleanName(channel.name)
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
	const kept = raw
		// Системні повідомлення (pin, join) і порожні без вкладень/ембедів пропускаємо
		.filter((m) => m.type === 0 || m.type === 19)
		.filter((m) => m.content || m.attachments?.length || m.embeds?.length)
	const messages = []
	for (const m of kept) messages.push(await toMessage(m, id))
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
