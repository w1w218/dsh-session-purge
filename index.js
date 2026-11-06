/**
 * dsh-session-purge — Host half.
 *
 * Deletes archived DSH sessions durably and reclaims attachment objects no
 * surviving session still references. The browser half renders the settings
 * page; this half owns every filesystem write.
 *
 * Design notes:
 * - Bookkeeping goes through the shipped registry API (`detachSession`,
 *   `unarchiveSession`), never by editing workspace.json behind the registry's
 *   back, so the running process and the durable document stay consistent.
 * - Every destructive path must sit strictly inside its expected root and must
 *   not be a symbolic link.
 * - A survivor log that cannot be decoded aborts the whole plan (fail-closed):
 *   without it we cannot prove an attachment is unreferenced.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents']

/** Route prefix owned by this plugin. */
const API_PATH = '/dsh-session-purge/api'
/** zstd frame magic; a log file is a concatenation of frames. */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
/** Attachment ids are `sha256:<64 hex>`. */
const SHA_REF = /sha256:[0-9a-f]{64}/g
/** Any session log generation: `session.v4.jsonl.zstd`, `session.jsonl.zstd`, ... */
const LOG_NAME = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
/** Request bodies are tiny; anything larger is refused. */
const MAX_BODY_BYTES = 256 * 1024
/** One purge request may name at most this many sessions. */
const MAX_TARGETS = 5000

// ---------------------------------------------------------------------------
// Paths and small utilities
// ---------------------------------------------------------------------------

/** Resolve the Harness home exactly like `@deepseek-ai/dsh-home-paths`. */
function resolveHome() {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return path.resolve(configured)
  return path.join(os.homedir(), '.dsh')
}

/** Path-encode one segment; mirrors the persistence backend. */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Whether `child` sits strictly inside `parent`. */
function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Whether `child` is a direct child of `parent`. */
function isDirectChild(child, parent) {
  if (!isInside(child, parent)) return false
  return path.dirname(path.resolve(child)) === path.resolve(parent)
}

async function statOrNull(target) {
  try {
    return await fs.lstat(target)
  } catch {
    return undefined
  }
}

/** Recursively measure a file or directory. */
async function measure(target) {
  const info = await statOrNull(target)
  if (info === undefined) return { bytes: 0, files: 0 }
  if (!info.isDirectory()) return { bytes: info.size, files: 1 }
  let bytes = 0
  let files = 0
  const queue = [target]
  while (queue.length > 0) {
    const current = queue.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(child)
      else if (entry.isFile()) {
        try {
          bytes += (await fs.stat(child)).size
          files += 1
        } catch {
          /* raced with another writer */
        }
      }
    }
  }
  return { bytes, files }
}

// ---------------------------------------------------------------------------
// Session log decoding
// ---------------------------------------------------------------------------

/**
 * Decompress every zstd frame in one log buffer.
 *
 * Node's decoder stops at the first frame, and the magic bytes can occur inside
 * compressed data, so frames are sliced by magic and retried with a later slice
 * end when a candidate fails. Any frame that never decodes fails the whole
 * file: the caller treats it as unreadable.
 * @param buffer - raw log bytes.
 * @returns concatenated plaintext.
 */
function decodeZstdFrames(buffer) {
  const offsets = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1]
      && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) offsets.push(index)
  }
  if (offsets.length === 0) throw new Error('no zstd frame found')
  if (offsets[0] !== 0) throw new Error('log does not start with a zstd frame')
  const parts = []
  let failed = 0
  for (let index = 0; index < offsets.length; index += 1) {
    let decoded = false
    for (let extra = 0; extra < 4 && !decoded; extra += 1) {
      const start = offsets[index]
      const end = index + 1 + extra < offsets.length ? offsets[index + 1 + extra] : buffer.length
      try {
        parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
        decoded = true
        index += extra
      } catch {
        /* magic inside compressed bytes; try a later frame boundary */
      }
    }
    if (!decoded) failed += 1
  }
  if (failed > 0) throw new Error(`${failed} zstd frame(s) failed to decode`)
  return parts.join('\n')
}

/** Read one session log file (zstd or plain JSONL) as text. */
async function readLogText(file) {
  const buffer = await fs.readFile(file)
  if (file.endsWith('.zstd')) return decodeZstdFrames(buffer)
  return buffer.toString('utf8')
}

/** Extract every attachment id mentioned by one log corpus. */
function extractRefs(text) {
  return new Set(text.match(SHA_REF) ?? [])
}

// ---------------------------------------------------------------------------
// Disk layout
// ---------------------------------------------------------------------------

/**
 * Index `<home>/sessions/<project>/<encoded id>` directories by directory name.
 * @param sessionsRoot - absolute sessions root.
 * @returns directory name → absolute directory path.
 */
async function indexSessionDirs(sessionsRoot) {
  const index = new Map()
  let projects
  try {
    projects = await fs.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return index
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(sessionsRoot, project.name)
    let entries
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      index.set(entry.name, path.join(projectDir, entry.name))
    }
  }
  return index
}

/** Resolve the transcript directory for one session id (encoded or raw name). */
function dirFor(index, id) {
  return index.get(encodeSegment(id)) ?? index.get(id)
}

/** List the log files of one session directory. */
async function listLogFiles(dir) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  return names.filter((name) => LOG_NAME.test(name)).map((name) => path.join(dir, name))
}

/** Extract the latest committed `session/title` value from one log corpus. */
function extractTitle(text) {
  let title = null
  for (const line of text.split('\n')) {
    if (!line.includes('"session/title"')) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const events = Array.isArray(parsed) ? parsed : [parsed]
    for (const event of events) {
      if (event?.type !== 'session/title') continue
      const value = event?.data?.title
      if (typeof value === 'string' && value.trim() !== '') title = value.trim()
    }
  }
  return title
}

/**
 * Read and decode every log generation of one directory.
 * @returns `{ refs, title }`, or null when the directory holds no log.
 */
async function readDirRefs(dir) {
  const files = await listLogFiles(dir)
  if (files.length === 0) return null
  const corpus = []
  for (const file of files) corpus.push(await readLogText(file))
  const text = corpus.join('\n')
  return { refs: extractRefs(text), title: extractTitle(text) }
}

/**
 * Enumerate attachment objects under `<home>/attachments/v1`.
 * @returns digest → { bytes, entries: Array<{ path, bucket, directory }> }.
 */
async function listBlobObjects(attachmentsRoot) {
  const objects = new Map()
  for (const bucket of ['objects', 'file-objects', 'files']) {
    const bucketRoot = path.join(attachmentsRoot, bucket)
    let prefixes
    try {
      prefixes = await fs.readdir(bucketRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue
      const prefixDir = path.join(bucketRoot, prefix.name)
      let entries
      try {
        entries = await fs.readdir(prefixDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!/^[0-9a-f]{64}$/.test(entry.name)) continue
        const target = path.join(prefixDir, entry.name)
        const measured = await measure(target)
        const current = objects.get(entry.name) ?? { bytes: 0, entries: [] }
        current.bytes += measured.bytes
        current.entries.push({ path: target, bucket, directory: entry.isDirectory() })
        objects.set(entry.name, current)
      }
    }
  }
  return objects
}

/** `<home>/cache/attachments/request-images` derived image cache. */
function requestImageCacheRoot(home) {
  return path.join(home, 'cache', 'attachments', 'request-images')
}

/** `<home>/storages/session_projcache/sessions` per-record projection cache. */
function projectionCacheRoot(home) {
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Read the registry-global archive set; null when the service does not expose it. */
function registryArchiveIds(registry) {
  try {
    const ids = registry?.archivedSessionIds
    if (Array.isArray(ids)) return ids.map(String)
  } catch {
    /* fall through to the storage document */
  }
  return null
}

/** Read the archive set from the storage document (stale while the process runs). */
async function fileArchiveIds(home) {
  const workspacePath = path.join(home, 'storages', 'workspace.json')
  const document = JSON.parse(await fs.readFile(workspacePath, 'utf8'))
  const ids = document?.global?.archivedSessionIds
  if (!Array.isArray(ids)) throw new Error('global.archivedSessionIds is missing')
  return ids.map(String)
}

/**
 * Whether a session is executing a turn right now, and whether a live Agent
 * object exists at all. The official archive admission checks the same
 * `status` field, so an idle archived Agent is not "running" even while its
 * Session object still lives in memory.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @returns `{ live, running }`; `running` stays conservative when the agent
 * service is unavailable.
 */
function liveness(ctx, id) {
  const live = ctx.sessions.get(id) !== undefined
  let agent
  try {
    agent = ctx.agents?.get?.(id)
  } catch {
    agent = undefined
  }
  if (agent !== undefined && agent !== null) return { live, running: agent.status === 'running' }
  return { live, running: live }
}

/** Collect subagent children keyed by parent session id. */
function childIndex(headers) {
  const children = new Map()
  for (const item of headers) {
    const parent = item?.header?.parentSession
    if (parent === undefined || item?.header?.origin !== 'subagent') continue
    const key = String(parent)
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(String(item.header.id))
  }
  return children
}

/** Recursively collect subagent descendants of one root id. */
function collectDescendants(children, rootId) {
  const found = []
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * Build the full plan: archived sessions, their transcript usage, the attachment
 * references of every transcript on disk, and the reclaimable blob sets.
 * @param ctx - Host plugin context.
 * @param options - `{ blobGc }`.
 */
async function scan(ctx, options) {
  const home = resolveHome()
  const sessionsRoot = path.join(home, 'sessions')
  const attachmentsRoot = path.join(home, 'attachments', 'v1')
  const warnings = []

  const registryIds = registryArchiveIds(ctx.workspaceRegistry)
  const archiveIds = registryIds ?? await fileArchiveIds(home)
  if (registryIds === null) warnings.push('archive-registry-getter-missing')

  let headers = []
  try {
    headers = await ctx.sessionPersistence.list()
  } catch (error) {
    warnings.push(`session-list-failed: ${String(error instanceof Error ? error.message : error)}`)
  }
  const children = childIndex(headers)
  const index = await indexSessionDirs(sessionsRoot)

  const sessions = []
  for (const id of archiveIds) {
    const dir = dirFor(index, id)
    let bytes = 0
    let refSet = null
    let title = null
    if (dir !== undefined) {
      bytes = (await measure(dir)).bytes
      try {
        const read = await readDirRefs(dir)
        if (read !== null) {
          refSet = read.refs
          title = read.title
        }
      } catch (error) {
        warnings.push(`log-unreadable:${id}: ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    const activity = liveness(ctx, id)
    sessions.push({
      id,
      title,
      dir: dir === undefined ? null : path.relative(home, dir),
      hasDir: dir !== undefined,
      bytes,
      refs: refSet === null ? 0 : refSet.size,
      live: activity.live,
      running: activity.running,
      descendants: collectDescendants(children, id),
      logReadable: refSet !== null,
      refSet,
    })
  }

  // Every transcript directory on disk is a survivor candidate; scanning each
  // one is what makes blob collection provable rather than best-effort.
  const targetDirs = new Set()
  for (const session of sessions) {
    const dir = dirFor(index, session.id)
    if (dir !== undefined) targetDirs.add(dir)
  }
  const survivorRefs = new Set()
  if (options.blobGc) {
    for (const [name, dir] of index) {
      if (targetDirs.has(dir)) continue
      let refs
      try {
        refs = await readDirRefs(dir)
      } catch (error) {
        throw new Error(
          `无法读取幸存会话 ${name} 的日志（${String(error instanceof Error ? error.message : error)}）；`
          + '无法确认附件是否仍被引用，已中止，未删除任何内容',
        )
      }
      if (refs === null) continue
      for (const ref of refs.refs) survivorRefs.add(ref)
    }
  }

  const targetRefs = new Set()
  let targetLogUnreadable = false
  for (const session of sessions) {
    if (!session.hasDir) continue
    if (session.refSet === null) {
      targetLogUnreadable = true
      continue
    }
    for (const ref of session.refSet) targetRefs.add(ref)
  }

  const objects = options.blobGc ? await listBlobObjects(attachmentsRoot) : new Map()
  const exclusiveRefs = new Set([...targetRefs].filter((ref) => !survivorRefs.has(ref)))
  const exclusiveObjects = []
  for (const [digest, object] of objects) {
    if (!exclusiveRefs.has(`sha256:${digest}`)) continue
    exclusiveObjects.push({ digest, bytes: object.bytes })
  }
  const orphanObjects = []
  for (const [digest, object] of objects) {
    if (survivorRefs.has(`sha256:${digest}`)) continue
    orphanObjects.push({ digest, bytes: object.bytes })
  }
  const cache = await measure(requestImageCacheRoot(home))

  return {
    home,
    sessions,
    index,
    objects,
    survivorRefs,
    targetRefs,
    targetLogUnreadable,
    referenceScanAvailable: options.blobGc && !targetLogUnreadable,
    exclusiveObjects,
    exclusiveBytes: exclusiveObjects.reduce((sum, item) => sum + item.bytes, 0),
    orphanObjects,
    orphanBytes: orphanObjects.reduce((sum, item) => sum + item.bytes, 0),
    cacheBytes: cache.bytes,
    sessionBytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Destructive operations
// ---------------------------------------------------------------------------

/** Remove one path after proving it is safe. Returns the bytes released. */
async function removePath(target, root, options = {}) {
  const info = await statOrNull(target)
  if (info === undefined) return 0
  if (info.isSymbolicLink()) throw new Error(`refusing symbolic link ${target}`)
  if (!isInside(target, root)) throw new Error(`refusing out-of-root path ${target}`)
  if (options.directChild === true && !isDirectChild(target, root)) {
    throw new Error(`refusing non-direct child ${target}`)
  }
  const measured = await measure(target)
  await fs.rm(target, { recursive: true, force: true })
  return measured.bytes
}

/** Copy workspace.json beside itself before any destructive step. */
async function backupWorkspace(home) {
  const source = path.join(home, 'storages', 'workspace.json')
  const info = await statOrNull(source)
  if (info === undefined) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '')
  const target = `${source}.bak-${stamp}`
  await fs.copyFile(source, target)
  return target
}

/**
 * Delete the sessions named by `requestedIds` (plus opted-in subagent
 * descendants) and reclaim the selected disk artifacts.
 * @param ctx - Host plugin context.
 * @param request - `{ ids, cascade, clearRequestImageCache, collectOrphans }`.
 */
async function purge(ctx, request) {
  const options = {
    cascade: request.cascade === true,
    clearRequestImageCache: request.clearRequestImageCache === true,
    collectOrphans: request.collectOrphans === true,
  }
  const requestedIds = Array.isArray(request.ids)
    ? [...new Set(request.ids.filter((id) => typeof id === 'string' && id !== ''))]
    : []
  if (requestedIds.length === 0) throw new Error('缺少要删除的会话 id')
  if (requestedIds.length > MAX_TARGETS) throw new Error(`单次最多处理 ${MAX_TARGETS} 个会话`)

  const plan = await scan(ctx, { blobGc: true })
  const byId = new Map(plan.sessions.map((session) => [session.id, session]))
  const unknown = requestedIds.filter((id) => !byId.has(id))
  if (unknown.length > 0) {
    throw new Error(`以下会话不在归档集合中，拒绝删除：${unknown.join(', ')}`)
  }

  const deleteIds = new Set(requestedIds)
  if (options.cascade) {
    for (const id of requestedIds) {
      for (const child of byId.get(id)?.descendants ?? []) deleteIds.add(child)
    }
  }

  // The backup is a precondition, not a best-effort step: no backup, no delete.
  const backupPath = await backupWorkspace(plan.home)

  const failures = []
  const deleted = []
  const warnings = [...plan.warnings]
  const sessionsRoot = path.join(plan.home, 'sessions')
  const projectionRoot = projectionCacheRoot(plan.home)
  const removedDirs = new Set()
  let freedBytes = 0

  const workspaces = ctx.workspaceRegistry.list()
  for (const id of deleteIds) {
    const known = byId.get(id)
    const dir = dirFor(plan.index, id)
    const activity = liveness(ctx, id)
    if (activity.running) {
      failures.push({ id, reason: '会话正在执行一轮（running），请先中断或等待结束后再清理' })
      continue
    }
    // An idle Agent still holding the Session in memory is fine: flush its live
    // events to disk before the transcript goes away, so the delete cannot lose
    // anything that was already committed.
    if (activity.live) {
      const session = ctx.sessions.get(id)
      if (session !== undefined) {
        try {
          await ctx.sessions.flush(session)
        } catch {
          /* best effort; the transcript is deleted next */
        }
      }
    }
    // 1. Bookkeeping through the shipped registry API. A failure leaves the
    //    transcript intact and the operation retryable.
    try {
      for (const workspace of workspaces) await workspace.detachSession(id)
      await ctx.workspaceRegistry.unarchiveSession(id)
    } catch (error) {
      failures.push({ id, reason: `更新归档/工作区记录失败：${String(error instanceof Error ? error.message : error)}` })
      continue
    }
    // 2. Transcript directory.
    let sessionBytes = 0
    if (dir !== undefined) {
      try {
        sessionBytes = await removePath(dir, sessionsRoot)
        removedDirs.add(dir)
      } catch (error) {
        failures.push({ id, reason: `删除会话目录失败：${String(error instanceof Error ? error.message : error)}` })
        continue
      }
    }
    // 3. Per-record projection cache.
    for (const name of [`${id}.json`, `${encodeSegment(id)}.json`]) {
      try {
        sessionBytes += await removePath(path.join(projectionRoot, name), projectionRoot, { directChild: true })
      } catch (error) {
        failures.push({ id, reason: `删除投影缓存失败：${String(error instanceof Error ? error.message : error)}` })
      }
    }
    freedBytes += sessionBytes
    deleted.push({ id, bytes: sessionBytes, dir: dir === undefined ? null : path.relative(sessionsRoot, dir) })
    // Drop the row from every connected browser immediately. The Session was
    // cold, so no `session/disposed` fires; this is the Host-to-Client removal
    // notification the session controller forwards to `api-session/removed`.
    try {
      ctx.emit('api-session/removed', id)
    } catch {
      /* notification is best-effort; the row disappears on the next reload */
    }
  }

  // 4. Attachment objects: recompute survivors from the directories that still
  //    exist, so a failed transcript deletion keeps its blobs referenced.
  let blobsRemoved = 0
  let blobBytes = 0
  let cacheBytes = 0
  if (deleted.length > 0) {
    const remainingRefs = new Set()
    for (const dir of plan.index.values()) {
      if (removedDirs.has(dir)) continue
      try {
        const refs = await readDirRefs(dir)
        if (refs !== null) for (const ref of refs.refs) remainingRefs.add(ref)
      } catch {
        warnings.push(`survivor-read-after-delete:${path.basename(dir)}`)
        remainingRefs.clear()
        for (const ref of plan.survivorRefs) remainingRefs.add(ref)
        break
      }
    }

    const wanted = new Set()
    let unreadable = false
    for (const session of plan.sessions) {
      const dir = dirFor(plan.index, session.id)
      if (dir === undefined || !removedDirs.has(dir)) continue
      if (session.refSet === null) {
        unreadable = true
        continue
      }
      for (const ref of session.refSet) wanted.add(ref)
    }
    if (unreadable && !options.collectOrphans) {
      warnings.push('blob-gc-skipped: target transcript unreadable')
    } else {
      const objects = await listBlobObjects(path.join(plan.home, 'attachments', 'v1'))
      for (const [digest, object] of objects) {
        const ref = `sha256:${digest}`
        if (remainingRefs.has(ref)) continue
        if (!options.collectOrphans && !wanted.has(ref)) continue
        for (const entry of object.entries) {
          try {
            blobBytes += await removePath(entry.path, path.join(plan.home, 'attachments', 'v1'))
            blobsRemoved += 1
          } catch (error) {
            failures.push({
              id: digest.slice(0, 12),
              reason: `删除附件对象失败：${String(error instanceof Error ? error.message : error)}`,
            })
          }
        }
      }
    }
    freedBytes += blobBytes

    if (options.clearRequestImageCache) {
      const cacheRoot = requestImageCacheRoot(plan.home)
      try {
        cacheBytes = await removePath(cacheRoot, path.join(plan.home, 'cache'))
        freedBytes += cacheBytes
      } catch (error) {
        failures.push({ id: 'request-images', reason: `清理 request-images 缓存失败：${String(error instanceof Error ? error.message : error)}` })
      }
    }
  }

  return {
    ok: failures.length === 0,
    deleted,
    failures,
    warnings,
    freedBytes,
    blobsRemoved,
    blobBytes,
    cacheBytes,
    backupPath,
    requiresRefresh: true,
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

/** Read and parse a bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function writeJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/** Route one API request to its operation. */
async function handleApi(ctx, req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const action = url.pathname.slice(API_PATH.length).replace(/^\/+/, '')
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const connection = ctx.get('connection')
    if (connection === undefined) {
      writeJson(res, 503, { ok: false, error: 'connection service unavailable' })
      return
    }
    const admission = connection.admit(req)
    if ('rejection' in admission) {
      res.writeHead(admission.rejection)
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
      return
    }
    if (action === 'scan') {
      const plan = await scan(ctx, { blobGc: true })
      writeJson(res, 200, {
        ok: true,
        home: plan.home,
        sessions: plan.sessions.map(({ refSet, ...rest }) => rest),
        summary: {
          sessionCount: plan.sessions.length,
          sessionBytes: plan.sessionBytes,
          exclusiveBlobCount: plan.exclusiveObjects.length,
          exclusiveBlobBytes: plan.exclusiveBytes,
          orphanBlobCount: plan.orphanObjects.length,
          orphanBlobBytes: plan.orphanBytes,
          cacheBytes: plan.cacheBytes,
          referenceScanAvailable: plan.referenceScanAvailable,
        },
        warnings: plan.warnings,
      })
      return
    }
    if (action === 'purge') {
      writeJson(res, 200, await purge(ctx, body ?? {}))
      return
    }
    writeJson(res, 404, { ok: false, error: `unknown action: ${action}` })
  } catch (error) {
    writeJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}

/**
 * Host plugin entry point.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PATH,
      handler: (req, res) => { void handleApi(webCtx, req, res) },
    }), 'session-purge: api route')
  })
}

/** Pure internals exposed for the package's offline self-test. */
export const __internal = {
  encodeSegment,
  isInside,
  decodeZstdFrames,
  indexSessionDirs,
  listBlobObjects,
  measure,
  scan,
  purge,
}

