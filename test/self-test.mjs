// Offline self-test for @local/dsh-session-purge: fixture home, fake services.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { __internal } from '../index.js'

const { scan, purge, encodeSegment } = __internal

const checks = []
const check = (ok, label) => checks.push({ ok: Boolean(ok), label })
const exists = async (target) => {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

const digest = (prefix) => prefix.repeat(32).slice(0, 64)
const EXCLUSIVE = `sha256:${digest('a1')}`
const SHARED = `sha256:${digest('b2')}`
const ORPHAN = `sha256:${digest('c3')}`

async function writeLog(root, project, id, refs, options = {}) {
  const dir = path.join(root, 'sessions', project, encodeSegment(id))
  await fs.mkdir(dir, { recursive: true })
  const frameA = JSON.stringify([{ type: 'meta', data: { refs: [] } }])
  const frameB = JSON.stringify([{ type: 'user/message', data: { refs } }])
  const frames = [frameA, frameB]
  if (options.title !== undefined) {
    frames.push(JSON.stringify([{
      type: 'session/title',
      data: { title: options.title, messageSeqs: [], source: { kind: 'fallback' } },
    }]))
  }
  const body = options.corrupt === true
    ? Buffer.from('not zstd at all')
    : Buffer.concat(frames.map((frame) => zstdCompressSync(Buffer.from(frame))))
  await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), body)
  return dir
}

async function writeBlob(root, ref) {
  const sha = ref.slice('sha256:'.length)
  const target = path.join(root, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, 'x'.repeat(2048))
  return target
}

function fakeContext(archiveIds, options = {}) {
  const calls = {
    detached: [],
    unarchived: [],
    flushed: [],
    removed: [],
    live: new Set(options.live ?? []),
    running: new Set(options.running ?? []),
  }
  const workspace = {
    detachSession: async (id) => { calls.detached.push(id) },
  }
  return {
    calls,
    ctx: {
      workspaceRegistry: {
        archivedSessionIds: archiveIds,
        list: () => [workspace],
        unarchiveSession: async (id) => { calls.unarchived.push(id) },
      },
      sessionPersistence: {
        list: async () => [],
      },
      sessions: {
        get: (id) => (calls.live.has(id) ? { id } : undefined),
        flush: async () => { calls.flushed.push('flush'); return true },
      },
      agents: {
        get: (id) => {
          if (calls.running.has(id)) return { id, status: 'running' }
          if (calls.live.has(id)) return { id, status: 'idle' }
          return undefined
        },
      },
      emit: (event, id) => {
        if (event === 'api-session/removed') calls.removed.push(id)
      },
    },
  }
}

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-purge-selftest-'))
  await fs.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await fs.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: ['session-archived'], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: 'P', title: 'p', sessionIds: ['session-archived', 'session-keeper'] } } },
  }, null, 2))
  const archivedDir = await writeLog(home, '--proj--', 'session-archived', [EXCLUSIVE, SHARED], { title: 'Archived fixture session' })
  const keeperDir = await writeLog(home, '--proj--', 'session-keeper', [SHARED])
  const exclusiveBlob = await writeBlob(home, EXCLUSIVE)
  const sharedBlob = await writeBlob(home, SHARED)
  const orphanBlob = await writeBlob(home, ORPHAN)
  await fs.mkdir(path.join(home, 'cache', 'attachments', 'request-images', 'ab'), { recursive: true })
  await fs.writeFile(path.join(home, 'cache', 'attachments', 'request-images', 'ab', 'v1'), 'derived')
  await fs.writeFile(path.join(home, 'storages', 'session_projcache', 'sessions', 'session-archived.json'), '{}')
  return { home, archivedDir, keeperDir, exclusiveBlob, sharedBlob, orphanBlob }
}

async function run() {
  const { home, archivedDir, keeperDir, exclusiveBlob, sharedBlob, orphanBlob } = await makeHome()
  process.env.DSH_HOME = home

  try {
    const fake = fakeContext(['session-archived'])
    const ctx = fake.ctx
    const plan = await scan(ctx, { blobGc: true })
    check(plan.sessions.length === 1 && plan.sessions[0].id === 'session-archived', 'scan lists the archived session')
    check(plan.sessions[0].title === 'Archived fixture session', 'scan reads the session title')
    check(plan.exclusiveObjects.some((item) => item.digest === EXCLUSIVE.slice(7)), 'exclusive blob detected')
    check(!plan.exclusiveObjects.some((item) => item.digest === SHARED.slice(7)), 'shared blob is not exclusive')
    check(plan.orphanObjects.some((item) => item.digest === ORPHAN.slice(7)), 'orphan blob detected')
    check(plan.cacheBytes > 0, 'request-image cache measured')

    const result = await purge(ctx, {
      ids: ['session-archived'],
      cascade: true,
      clearRequestImageCache: true,
      collectOrphans: true,
    })
    check(result.ok === true, 'purge reports success')
    check(result.deleted.length === 1, 'one session deleted')
    check(!(await exists(archivedDir)), 'archived transcript removed')
    check(await exists(keeperDir), 'survivor transcript kept')
    check(!(await exists(exclusiveBlob)), 'exclusive blob reclaimed')
    check(await exists(sharedBlob), 'shared blob kept')
    check(!(await exists(orphanBlob)), 'orphan blob reclaimed')
    check(!(await exists(path.join(home, 'storages', 'session_projcache', 'sessions', 'session-archived.json'))), 'projection cache removed')
    check(!(await exists(path.join(home, 'cache', 'attachments', 'request-images'))), 'request-image cache cleared')
    check(result.backupPath !== null && (await exists(result.backupPath)), 'workspace.json backup written')
    check(fake.calls.detached.includes('session-archived'), 'workspace detach called')
    check(fake.calls.unarchived.includes('session-archived'), 'registry unarchive called')
    check(fake.calls.removed.includes('session-archived'), 'client removal event emitted')

    // Fail-closed: an undecodable survivor must abort the scan.
    const broken = await makeHome()
    await writeLog(broken.home, '--proj--', 'session-keeper', [], { corrupt: true })
    process.env.DSH_HOME = broken.home
    let aborted = false
    try {
      await scan(fakeContext(['session-archived']).ctx, { blobGc: true })
    } catch {
      aborted = true
    }
    check(aborted, 'undecodable survivor aborts the scan')
    await fs.rm(broken.home, { recursive: true, force: true })

    // A running target is refused and its transcript survives.
    process.env.DSH_HOME = home
    const runningHome = await makeHome()
    process.env.DSH_HOME = runningHome.home
    const running = fakeContext(['session-archived'], { live: ['session-archived'], running: ['session-archived'] })
    const runningResult = await purge(running.ctx, {
      ids: ['session-archived'],
      cascade: false,
      clearRequestImageCache: false,
      collectOrphans: false,
    })
    check(runningResult.ok === false && runningResult.failures.some((item) => item.id === 'session-archived'), 'running target refused')
    check(await exists(runningHome.archivedDir), 'running transcript kept')
    await fs.rm(runningHome.home, { recursive: true, force: true })

    // A live-but-idle Agent is flushable, so its archived session is deletable.
    const idleHome = await makeHome()
    process.env.DSH_HOME = idleHome.home
    const idle = fakeContext(['session-archived'], { live: ['session-archived'] })
    const idleResult = await purge(idle.ctx, {
      ids: ['session-archived'],
      cascade: false,
      clearRequestImageCache: false,
      collectOrphans: false,
    })
    check(idleResult.ok === true && idleResult.deleted.length === 1, 'idle live target deleted')
    check(idle.calls.flushed.length === 1, 'live session flushed before delete')
    check(!(await exists(idleHome.archivedDir)), 'idle live transcript removed')
    await fs.rm(idleHome.home, { recursive: true, force: true })

    // Unknown ids are refused before any write.
    const unknown = fakeContext(['session-archived'])
    let refused = false
    try {
      await purge(unknown.ctx, { ids: ['session-not-archived'] })
    } catch {
      refused = true
    }
    check(refused, 'non-archived id refused')

    for (const item of checks) console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.label}`)
    const failures = checks.filter((item) => !item.ok).length
    console.log(`\n${checks.length - failures}/${checks.length} passed`)
    return failures === 0
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

run().then((ok) => { process.exitCode = ok ? 0 : 1 }).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
