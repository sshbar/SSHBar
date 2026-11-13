#!/usr/bin/env node
// Convert a Termix host export into an SSHBuddy import file.
//   node --no-warnings scripts/convert-termix.mjs <termix.json> <out.json> [--pp-key "<Vault>/<SSH key item title>"]
// --pp-key: hosts that used a key in Termix get this Proton Pass SSH key item (resolved with pass-cli;
//           only the item's ids are stored, never the key itself).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { convertTermix, isTermixExport } from '../src/main/importers/termix.ts'

const [input, output, ...rest] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: node scripts/convert-termix.mjs <termix.json> <out.json> [--pp-key "Vault/Item title"]')
  process.exit(2)
}
const ppKey = rest[rest.indexOf('--pp-key') + 1]
const data = JSON.parse(readFileSync(input, 'utf8'))
if (!isTermixExport(data)) {
  console.error('That does not look like a Termix host export')
  process.exit(1)
}

let keyAuth
if (rest.includes('--pp-key') && ppKey) {
  const [vaultName, ...titleParts] = ppKey.split('/')
  const title = titleParts.join('/')
  const pass = (args) => JSON.parse(execFileSync('pass-cli', [...args, '--output', 'json'], { encoding: 'utf8' }))
  const vault = pass(['vault', 'list']).vaults.find((v) => v.name === vaultName)
  if (!vault) throw new Error(`Proton Pass vault "${vaultName}" not found`)
  const items = pass(['item', 'list', '--share-id', vault.share_id, '--filter-type', 'ssh-key', '--filter-state', 'active']).items.filter((i) => i.title === title)
  if (items.length !== 1) throw new Error(`Expected exactly one SSH key item titled "${title}" in "${vaultName}", found ${items.length}`)
  keyAuth = {
    method: 'key',
    password: { source: 'prompt' },
    key: { source: 'protonpass', shareId: items[0].share_id || vault.share_id, itemId: items[0].id, title },
    passphrase: { source: 'prompt' },
    agent: 'system',
    agentSocket: ''
  }
}

const { hosts, skipped } = convertTermix(data, { keyAuth })
const now = Date.now()
writeFileSync(
  output,
  JSON.stringify({ app: 'SSHBuddy', version: 1, source: 'termix', hosts: hosts.map((h) => ({ ...h, createdAt: now, updatedAt: now })) }, null, 2),
  { mode: 0o600 }
)
const count = (pred) => hosts.filter(pred).length
console.log(`Converted ${hosts.length} host(s) -> ${output}`)
console.log(`  key auth${keyAuth ? ` (Proton Pass: ${ppKey})` : ''}: ${count((h) => h.auth.method === 'key')}`)
console.log(`  password, ask on connect: ${count((h) => h.auth.method === 'password')}`)
const groups = {}
for (const h of hosts) groups[h.group || '(no group)'] = (groups[h.group || '(no group)'] ?? 0) + 1
console.log('  groups:', Object.entries(groups).map(([g, n]) => `${g} (${n})`).join(', '))
for (const s of skipped) console.log(`  skipped ${s.name}: ${s.reason}`)
