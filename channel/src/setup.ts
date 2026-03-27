#!/usr/bin/env node
/**
 * One-time setup script: connects to Discord, creates #main, #notifications,
 * #tasks channels (if they don't exist), and saves their IDs to config.json.
 */
import 'dotenv/config'
import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const ORCH_HOME = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')
const CONFIG_PATH = join(ORCH_HOME, 'config.json')

const REQUIRED_CHANNELS = ['main', 'notifications', 'tasks'] as const

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN
  const guildId = process.env.GUILD_ID

  if (!token || !guildId) {
    console.error('Missing DISCORD_BOT_TOKEN or GUILD_ID in .env')
    process.exit(1)
  }

  console.log('Connecting to Discord...')

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  })

  await client.login(token)

  await new Promise<void>((resolve) => {
    client.once('ready', () => resolve())
  })

  console.log(`Logged in as ${client.user!.tag}`)

  const guild = await client.guilds.fetch(guildId)
  console.log(`Server: ${guild.name}`)

  const existingChannels = await guild.channels.fetch()
  const channelIds: Record<string, string> = {}

  for (const name of REQUIRED_CHANNELS) {
    // Check if channel already exists
    const existing = existingChannels.find(
      (ch) => ch && ch.name === name && ch.type === ChannelType.GuildText
    )

    if (existing) {
      console.log(`  #${name} already exists (${existing.id})`)
      channelIds[`${name}_channel_id`] = existing.id
    } else {
      console.log(`  Creating #${name}...`)
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
      })
      console.log(`  Created #${name} (${channel.id})`)
      channelIds[`${name}_channel_id`] = channel.id
    }
  }

  // Update config.json
  let config: Record<string, any> = {}
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    // fresh config
  }

  config.discord = {
    ...config.discord,
    guild_id: guildId,
    ...channelIds,
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  console.log(`\nConfig updated: ${CONFIG_PATH}`)
  console.log(JSON.stringify(config.discord, null, 2))

  // Post a welcome message in #main
  const mainChannelId = channelIds['main_channel_id']
  const mainChannel = await client.channels.fetch(mainChannelId)
  if (mainChannel?.isTextBased()) {
    await (mainChannel as any).send(
      '🤖 **Claude Orchestrator** connected.\n' +
      'Talk to me here. I can spawn workers, manage projects, and more.\n' +
      'Worker threads will appear in #tasks or in project channels.'
    )
    console.log('\nWelcome message posted in #main')
  }

  console.log('\nSetup complete! You can now run:')
  console.log('  claude --channels server:orchestrator-discord --dangerously-load-development-channels')

  client.destroy()
  process.exit(0)
}

main().catch((err) => {
  console.error('Setup failed:', err)
  process.exit(1)
})
