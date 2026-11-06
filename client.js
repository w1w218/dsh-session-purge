/**
 * dsh-session-purge — Client half.
 *
 * Renders one page inside Settings → Session purge: it lists the archived
 * sessions reported by the Host half, lets the user pick targets and reclaim
 * options, and performs the destructive call only after an explicit confirm.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-purge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const API = '/dsh-session-purge/api'

    const EN = {
      nav: 'Session purge',
      title: 'Purge archived sessions',
      subtitle:
        'Permanently deletes archived sessions from disk and reclaims attachment objects no remaining session references. This cannot be undone.',
      refresh: 'Rescan',
      scanning: 'Scanning…',
      selectAll: 'Select all',
      selectNone: 'Clear selection',
      empty: 'No archived sessions.',
      live: 'running',
      noFiles: 'no files',
      logUnreadable: 'log unreadable',
      descendants: 'subagent descendants',
      refs: 'attachment refs',
      optionsTitle: 'Reclaim',
      cascade: 'Delete subagent descendants of selected sessions',
      cascadeHint: 'A selected parent takes its subagent child sessions with it.',
      cache: 'Clear request-image cache',
      cacheHint: 'Derived images are rebuilt automatically when needed.',
      orphans: 'Reclaim orphan attachment objects',
      orphansHint: 'Objects referenced by no session at all, including ones left by earlier deletions.',
      summary: 'Sessions {sessions} · {sessionBytes} · exclusive blobs {blobs} · orphan blobs {orphans} · image cache {cache}',
      delete: 'Delete selected',
      deleteCount: 'Delete {count}',
      confirmTitle: 'Delete archived sessions?',
      confirmBody:
        'This permanently removes {count} session transcript(s) and the selected reclamation targets. It cannot be undone.',
      confirmCancel: 'Cancel',
      confirmOk: 'Delete permanently',
      resultTitle: 'Result',
      resultDeleted: 'Sessions deleted: {count}',
      resultFreed: 'Disk space freed: {size}',
      resultBlobs: 'Attachment objects removed: {count} ({size})',
      resultCache: 'Image cache cleared: {size}',
      resultBackup: 'workspace.json backup: {path}',
      resultFailures: 'Failures:',
      resultRestart: 'Reload the page to refresh the session list.',
      errorLoad: 'Scan failed: {message}',
      errorDelete: 'Delete failed: {message}',
      warningPrefix: 'Warning: ',
    }

    const ZH = {
      nav: '会话清理',
      title: '清理归档会话',
      subtitle:
        '从磁盘上永久删除归档会话，并回收不再被任何剩余会话引用的附件对象。此操作不可撤销。',
      refresh: '重新扫描',
      scanning: '扫描中…',
      selectAll: '全选',
      selectNone: '取消全选',
      empty: '没有归档会话。',
      live: '运行中',
      noFiles: '无文件',
      logUnreadable: '日志不可读',
      descendants: '子会话',
      refs: '附件引用',
      optionsTitle: '回收项',
      cascade: '连带删除选中会话的 subagent 子会话',
      cascadeHint: '选中的父会话会连同它的子会话一起删除。',
      cache: '清理 request-images 派生缓存',
      cacheHint: '派生图会在需要时自动重建。',
      orphans: '回收孤儿附件对象',
      orphansHint: '把所有会话都不再引用的对象一并回收，包括早先删除遗留的对象。',
      summary: '会话 {sessions} 个 · {sessionBytes} · 独占附件 {blobs} 个 · 孤儿附件 {orphans} 个 · 图片缓存 {cache}',
      delete: '删除选中',
      deleteCount: '删除 {count} 个',
      confirmTitle: '确认删除归档会话？',
      confirmBody: '将永久删除 {count} 个会话转录以及选中的回收目标，操作不可撤销。',
      confirmCancel: '取消',
      confirmOk: '永久删除',
      resultTitle: '执行结果',
      resultDeleted: '已删除会话：{count} 个',
      resultFreed: '释放磁盘空间：{size}',
      resultBlobs: '已回收附件对象：{count} 个（{size}）',
      resultCache: '已清理图片缓存：{size}',
      resultBackup: 'workspace.json 备份：{path}',
      resultFailures: '失败项：',
      resultRestart: '请刷新页面以更新会话列表。',
      errorLoad: '扫描失败：{message}',
      errorDelete: '删除失败：{message}',
      warningPrefix: '警告：',
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
    }

    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    const STYLES = `
.dsp-root { color: var(--dsw-alias-label-primary); max-width: 920px; }
.dsp-title { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.dsp-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 0 0 16px; line-height: 1.6; }
.dsp-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.dsp-btn { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
.dsp-btn:disabled { opacity: .5; cursor: default; }
.dsp-btn-ghost { background: transparent; border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.dsp-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsp-btn-primary { background: var(--dsw-alias-brand-primary); color: #fff; }
.dsp-btn-primary:disabled { background: var(--dsw-alias-state-idle-primary); }
.dsp-btn-danger { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsp-list { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.dsp-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); border-top: 1px solid var(--dsw-alias-border-l1); }
.dsp-row:first-child { border-top: 0; }
.dsp-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsp-row-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsp-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
.dsp-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.dsp-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsp-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsp-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dsp-badge-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsp-empty { padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsp-options { margin: 16px 0 0; }
.dsp-options-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; }
.dsp-option { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; font-size: 13px; }
.dsp-option input { margin-top: 2px; }
.dsp-option-note { display: block; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 2px; }
.dsp-summary { margin: 16px 0; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 1.7; }
.dsp-warnings { margin: 8px 0 0; padding-left: 18px; color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
.dsp-result { margin-top: 16px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 1.7; }
.dsp-result-title { font-weight: 600; margin-bottom: 6px; font-size: 13px; }
.dsp-result-error { color: var(--dsw-alias-state-error-primary); }
.dsp-result-list { margin: 6px 0 0; padding-left: 18px; }
.dsp-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dsp-dialog { background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 20px; width: min(460px, calc(100vw - 48px)); box-shadow: 0 12px 32px rgba(0,0,0,.35); }
.dsp-dialog h3 { margin: 0 0 8px; font-size: 15px; }
.dsp-dialog p { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.dsp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.dsp-spacer { flex: 1; }
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A previous module generation may leave its dictionaries behind when it
        // unloads without a disposer; keep using whatever is already registered.
        ctx.effect(() => {
          try {
            return ctx.locale.register('session-purge', { en: EN, zh: ZH })
          } catch {
            return () => {}
          }
        }, 'session-purge: locale')
        const translate = ctx.locale.bind('session-purge')
        const tr = (key, values) => {
          let text
          try {
            text = translate(key)
          } catch {
            text = undefined
          }
          if (typeof text !== 'string' || text === '') text = ZH[key] ?? EN[key] ?? key
          return values === undefined ? text : fill(text, values)
        }

        function Styles() {
          return h('style', null, STYLES)
        }

        function PurgePage() {
          const [loading, setLoading] = useState(true)
          const [plan, setPlan] = useState(null)
          const [error, setError] = useState(null)
          const [selected, setSelected] = useState(() => new Set())
          const [options, setOptions] = useState({ cascade: true, clearRequestImageCache: true, collectOrphans: true })
          const [confirming, setConfirming] = useState(false)
          const [busy, setBusy] = useState(false)
          const [result, setResult] = useState(null)

          async function scan(config) {
            const clearResult = !config || config.clearResult !== false
            setLoading(true)
            setError(null)
            if (clearResult) setResult(null)
            try {
              const response = await fetch(`${API}/scan`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
              })
              const data = await response.json().catch(() => null)
              if (!response.ok || data === null || data.ok !== true) {
                throw new Error((data && data.error) || `HTTP ${response.status}`)
              }
              setPlan(data)
              setSelected(new Set(data.sessions.filter((session) => !session.running).map((session) => session.id)))
            } catch (failure) {
              setError(String((failure && failure.message) || failure))
            } finally {
              setLoading(false)
            }
          }

          useEffect(() => {
            void scan()
          }, [])

          useEffect(() => {
            if (!confirming) return undefined
            const onKey = (event) => {
              if (event.key === 'Escape') setConfirming(false)
            }
            window.addEventListener('keydown', onKey)
            return () => window.removeEventListener('keydown', onKey)
          }, [confirming])

          const sessions = (plan && plan.sessions) || []
          const selectedSessions = sessions.filter((session) => selected.has(session.id))
          const selectedCount = selectedSessions.length
          const selectedBytes = selectedSessions.reduce((sum, session) => sum + session.bytes, 0)

          function toggle(id) {
            setSelected((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }

          async function execute() {
            setBusy(true)
            setConfirming(false)
            setError(null)
            try {
              const response = await fetch(`${API}/purge`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  ids: selectedSessions.map((session) => session.id),
                  cascade: options.cascade,
                  clearRequestImageCache: options.clearRequestImageCache,
                  collectOrphans: options.collectOrphans,
                }),
              })
              const data = await response.json().catch(() => null)
              if (!response.ok || data === null) {
                throw new Error((data && data.error) || `HTTP ${response.status}`)
              }
              setResult(null)
              await scan({ clearResult: false })
              setResult(data)
            } catch (failure) {
              setError(String((failure && failure.message) || failure))
            } finally {
              setBusy(false)
            }
          }

          const summary = (plan && plan.summary) || null
          const warnings = (plan && plan.warnings) || []

          return h('div', { className: 'dsp-root' },
            h(Styles),
            h('h2', { className: 'dsp-title' }, tr('title')),
            h('p', { className: 'dsp-sub' }, tr('subtitle')),

            h('div', { className: 'dsp-toolbar' },
              h('button', {
                type: 'button',
                className: 'dsp-btn dsp-btn-ghost',
                onClick: () => { void scan() },
                disabled: loading || busy,
              }, loading ? tr('scanning') : tr('refresh')),
              h('button', {
                type: 'button',
                className: 'dsp-btn dsp-btn-ghost',
                onClick: () => setSelected(new Set(sessions.filter((session) => !session.running).map((session) => session.id))),
                disabled: loading || busy || sessions.length === 0,
              }, tr('selectAll')),
              h('button', {
                type: 'button',
                className: 'dsp-btn dsp-btn-ghost',
                onClick: () => setSelected(new Set()),
                disabled: loading || busy || sessions.length === 0,
              }, tr('selectNone')),
              h('span', { className: 'dsp-spacer' }),
              h('button', {
                type: 'button',
                className: 'dsp-btn dsp-btn-danger',
                onClick: () => setConfirming(true),
                disabled: loading || busy || selectedCount === 0,
              }, tr('deleteCount', { count: selectedCount })),
            ),

            error !== null ? h('div', { className: 'dsp-result dsp-result-error' }, error) : null,

            h('div', { className: 'dsp-list' },
              sessions.length === 0 ? h('div', { className: 'dsp-empty' }, loading ? tr('scanning') : tr('empty')) : null,
              sessions.map((session) => h('label', { className: 'dsp-row', key: session.id },
                h('input', {
                  type: 'checkbox',
                  checked: selected.has(session.id),
                  onChange: () => toggle(session.id),
                  disabled: busy || session.running,
                }),
                h('span', { className: 'dsp-row-main' },
                  h('span', { className: 'dsp-name', title: session.id }, session.title || session.id),
                  session.title ? h('span', { className: 'dsp-id', title: session.id }, session.id) : null,
                  session.running ? h('span', { className: 'dsp-badge dsp-badge-warn' }, tr('live')) : null,
                  !session.hasDir ? h('span', { className: 'dsp-badge' }, tr('noFiles')) : null,
                  session.hasDir && !session.logReadable ? h('span', { className: 'dsp-badge dsp-badge-error' }, tr('logUnreadable')) : null,
                  session.descendants && session.descendants.length > 0
                    ? h('span', { className: 'dsp-badge' }, `${tr('descendants')} ${session.descendants.length}`)
                    : null,
                  h('span', { className: 'dsp-meta' }, `${session.refs} ${tr('refs')}`),
                ),
                h('span', { className: 'dsp-meta' }, formatBytes(session.bytes)),
              )),
            ),

            summary !== null ? h('div', { className: 'dsp-summary' },
              tr('summary', {
                sessions: summary.sessionCount,
                sessionBytes: formatBytes(summary.sessionBytes),
                blobs: summary.exclusiveBlobCount,
                orphans: summary.orphanBlobCount,
                cache: formatBytes(summary.cacheBytes),
              }),
              warnings.length > 0 ? h('ul', { className: 'dsp-warnings' },
                warnings.map((warning, index) => h('li', { key: index }, tr('warningPrefix') + warning))) : null,
            ) : null,

            h('div', { className: 'dsp-options' },
              h('div', { className: 'dsp-options-title' }, tr('optionsTitle')),
              h('label', { className: 'dsp-option' },
                h('input', {
                  type: 'checkbox',
                  checked: options.cascade,
                  onChange: (event) => setOptions((current) => ({ ...current, cascade: event.target.checked })),
                }),
                h('span', null, tr('cascade'), h('span', { className: 'dsp-option-note' }, tr('cascadeHint'))),
              ),
              h('label', { className: 'dsp-option' },
                h('input', {
                  type: 'checkbox',
                  checked: options.clearRequestImageCache,
                  onChange: (event) => setOptions((current) => ({ ...current, clearRequestImageCache: event.target.checked })),
                }),
                h('span', null, tr('cache'), h('span', { className: 'dsp-option-note' }, tr('cacheHint'))),
              ),
              h('label', { className: 'dsp-option' },
                h('input', {
                  type: 'checkbox',
                  checked: options.collectOrphans,
                  onChange: (event) => setOptions((current) => ({ ...current, collectOrphans: event.target.checked })),
                }),
                h('span', null, tr('orphans'), h('span', { className: 'dsp-option-note' }, tr('orphansHint'))),
              ),
            ),

            result !== null ? h('div', { className: 'dsp-result' },
              h('div', { className: 'dsp-result-title' }, tr('resultTitle')),
              h('div', null, tr('resultDeleted', { count: (result.deleted || []).length })),
              h('div', null, tr('resultFreed', { size: formatBytes(result.freedBytes) })),
              h('div', null, tr('resultBlobs', { count: result.blobsRemoved || 0, size: formatBytes(result.blobBytes || 0) })),
              result.cacheBytes > 0 ? h('div', null, tr('resultCache', { size: formatBytes(result.cacheBytes) })) : null,
              result.backupPath ? h('div', null, tr('resultBackup', { path: result.backupPath })) : null,
              (result.failures || []).length > 0
                ? h('div', null,
                  h('div', { className: 'dsp-result-error' }, tr('resultFailures')),
                  h('ul', { className: 'dsp-result-list' },
                    result.failures.map((failure, index) => h('li', { key: index }, `${failure.id}: ${failure.reason}`))))
                : null,
              h('div', { className: 'dsp-meta' }, tr('resultRestart')),
            ) : null,

            confirming ? h('div', { className: 'dsp-overlay', role: 'presentation' },
              h('div', { className: 'dsp-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('confirmTitle') },
                h('h3', null, tr('confirmTitle')),
                h('p', null, tr('confirmBody', { count: selectedCount })),
                h('p', { className: 'dsp-meta' }, `${formatBytes(selectedBytes)}`),
                h('div', { className: 'dsp-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dsp-btn dsp-btn-ghost',
                    onClick: () => setConfirming(false),
                  }, tr('confirmCancel')),
                  h('button', {
                    type: 'button',
                    className: 'dsp-btn dsp-btn-danger',
                    onClick: () => { void execute() },
                  }, tr('confirmOk')),
                ),
              ),
            ) : null,
          )
        }

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-purge',
          order: 30,
          label: () => tr('nav'),
        }, PurgePage)), 'session-purge: settings page')
      },
    }
  },
})
