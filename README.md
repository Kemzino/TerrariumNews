# TerrariumNews

Стрічка новин спільноти Terrarium для лаунчера. GitHub Actions кожні 10 хвилин читає
три канали Discord бот-токеном (`DISCORD_BOT_TOKEN` у секретах) і оновлює `news.json`.

Лаунчер читає `https://raw.githubusercontent.com/Kemzino/TerrariumNews/main/news.json`.

- Список каналів: `scripts/fetch-news.mjs` → `CHANNEL_IDS` (порядок = порядок вкладок).
- Запустити руками: Actions → «Оновити стрічку новин» → Run workflow.
