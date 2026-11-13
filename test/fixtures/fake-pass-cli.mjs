#!/usr/bin/env node
// Minimal stand-in for `pass-cli` used by the sync tests. State lives in $FAKE_PASS_STATE.
import { readFileSync, writeFileSync } from 'node:fs'
const file = process.env.FAKE_PASS_STATE
const state = (() => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { items: [] } } })()
const save = () => writeFileSync(file, JSON.stringify(state))
const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
const cmd = args.filter((a) => !a.startsWith('--')).slice(0, 3).join(' ')
state.log = [...(state.log ?? []), args.join(' ')]

if (args[0] === '--version') { console.log('Proton Pass CLI 9.9.9 (fake)'); process.exit(0) }
if (cmd.startsWith('item list')) {
  const items = state.items.filter((i) => i.share_id === opt('--share-id') && (!opt('--filter-type') || i.item_type === opt('--filter-type').replace('-', '_')))
  console.log(JSON.stringify({ items: items.map(({ id, share_id, title, item_type }) => ({ id, share_id, title, item_type, state: 'Active' })) }))
} else if (cmd.startsWith('item create note')) {
  const id = 'item-' + (state.items.length + 1)
  state.items.push({ id, share_id: opt('--share-id'), title: opt('--title'), item_type: 'note', note: opt('--note'), extra_fields: [] })
  console.log(id)
} else if (cmd.startsWith('item view')) {
  const it = state.items.find((i) => i.id === opt('--item-id') && i.share_id === opt('--share-id'))
  if (!it) { console.error('Item not found'); process.exit(1) }
  console.log(JSON.stringify({ item: { id: it.id, share_id: it.share_id, content: { title: it.title, note: it.note, content: { Note: null }, extra_fields: it.extra_fields } } }))
} else if (cmd.startsWith('item update')) {
  const it = state.items.find((i) => i.id === opt('--item-id') && i.share_id === opt('--share-id'))
  if (!it) { console.error('Item not found'); process.exit(1) }
  for (const f of all('--field')) {
    const eq = f.indexOf('=')
    const name = f.slice(0, eq), value = f.slice(eq + 1)
    const ex = it.extra_fields.find((x) => x.name === name)
    if (ex) ex.content = { Text: value }
    else it.extra_fields.push({ name, content: { Text: value } })
  }
} else { console.error('unsupported: ' + args.join(' ')); process.exit(2) }
save()
