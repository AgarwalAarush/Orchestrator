/**
 * Lightweight Discord REST API wrapper.
 * Uses fetch() directly — no discord.js Client or gateway connection needed.
 * The official Discord plugin maintains the gateway; this only makes REST calls.
 */

const API_BASE = 'https://discord.com/api/v10'

let botToken: string | undefined

export function initDiscordRest(token: string): void {
  botToken = token
}

function getToken(): string {
  if (!botToken) throw new Error('Discord REST not initialized. Call initDiscordRest(token) first.')
  return botToken
}

async function discordFetch(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bot ${getToken()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Discord API ${options.method || 'GET'} ${path} failed (${res.status}): ${body}`)
  }

  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Send a message to a channel or thread. Returns the message object. */
export async function sendMessage(channelId: string, content: string): Promise<{ id: string }> {
  return discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

/** Edit an existing message. */
export async function editMessage(channelId: string, messageId: string, content: string): Promise<{ id: string }> {
  return discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

/** Create a public thread in a text channel. Returns the thread channel object. */
export async function createThread(
  channelId: string,
  name: string,
  autoArchiveDuration: number = 10080 // 7 days
): Promise<{ id: string }> {
  return discordFetch(`/channels/${channelId}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      auto_archive_duration: autoArchiveDuration,
      type: 11, // PUBLIC_THREAD
    }),
  })
}

/** Pin a message in a channel or thread. */
export async function pinMessage(channelId: string, messageId: string): Promise<void> {
  await discordFetch(`/channels/${channelId}/pins/${messageId}`, {
    method: 'PUT',
  })
}

/** Create a text channel in a guild, optionally under a category. Returns the channel object. */
export async function createGuildChannel(guildId: string, name: string, parentId?: string): Promise<{ id: string }> {
  const body: Record<string, any> = { name, type: 0 /* GUILD_TEXT */ }
  if (parentId) body.parent_id = parentId
  return discordFetch(`/guilds/${guildId}/channels`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Create a category in a guild. Returns the category object. */
export async function createGuildCategory(guildId: string, name: string): Promise<{ id: string }> {
  return discordFetch(`/guilds/${guildId}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: 4, // GUILD_CATEGORY
    }),
  })
}

/** List all channels in a guild. */
export async function listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string; type: number; parent_id?: string }>> {
  return discordFetch(`/guilds/${guildId}/channels`, { method: 'GET' })
}
