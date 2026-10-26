/* Apple Calendar setup stays user-driven. No permission prompt on page load. */
(() => {
  const sidebar = document.querySelector('.sidebar')
  if (!sidebar) return
  const entry = document.createElement('button')
  entry.type = 'button'; entry.className = 'nav'; entry.textContent = '⇄  Apple 日历同步'
  entry.style.cssText = 'margin:12px 0 8px;color:var(--accent);flex:none'
  const mini = sidebar.querySelector('.mini')
  sidebar.insertBefore(entry, mini)
  const style = document.createElement('style')
  style.textContent = `
    .apple-sync-dialog{width:min(520px,90vw);border:1px solid #dce3eb;border-radius:14px;padding:24px;color:#24313e;background:#fff;box-shadow:0 16px 60px #16243233;font:13px/1.65 -apple-system,BlinkMacSystemFont,sans-serif}
    .apple-sync-dialog::backdrop{background:#1c2b3a55}
    .apple-sync-dialog h2{margin:0 0 12px;font-size:19px}
    .apple-sync-dialog p{margin:8px 0}
    .apple-sync-dialog button{padding:7px 12px;border-radius:7px;border:1px solid #dce3eb;margin:6px 6px 0 0;color:#315f9d}
    .apple-sync-dialog button:disabled{opacity:.5;cursor:wait}
    .apple-sync-dialog select{max-width:100%;padding:7px;border:1px solid #dce3eb;border-radius:6px;background:#fff}
    .apple-sync-dialog pre{white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;padding:10px;border-radius:6px;background:#f5f7fa;font:12px/1.6 -apple-system,sans-serif}
    .apple-sync-actions{border-top:1px solid #e7ebef;margin-top:16px;padding-top:10px}
  `
  document.head.appendChild(style)
  const dialog = document.createElement('dialog'); dialog.className = 'apple-sync-dialog'
  const heading = document.createElement('h2'); heading.textContent = 'Apple 日历 · 双向同步'; dialog.appendChild(heading)
  const intro = document.createElement('p')
  intro.textContent = '仅同步独立的「日历清单」日历：标题、日期、时间与备注。完成状态和看板分组保留在插件内。Mac 与 DSH 运行时每 30 秒同步一次；手机端由 iCloud 负责分发。'
  dialog.appendChild(intro)
  const status = document.createElement('pre'); status.setAttribute('role', 'status'); dialog.appendChild(status)
  const sourceLabel = document.createElement('label'); sourceLabel.textContent = '目标账户（请选择 iCloud）： '
  const sources = document.createElement('select'); sourceLabel.appendChild(sources); dialog.appendChild(sourceLabel)
  const warning = document.createElement('p')
  warning.textContent = '首次启用前自动备份任务。冲突不自动覆盖；手机删除事件时先保留插件任务并标记冲突，防止误删。只导入专用日历内过去 1 年到未来 2 年的事件，已关联事件不受这个窗口限制。暂不编辑重复事件。'
  dialog.appendChild(warning)
  const actions = document.createElement('div'); actions.className = 'apple-sync-actions'; dialog.appendChild(actions)
  let snapshot = null, busy = false, refreshTimer
  async function request(path, data) {
    const response = await fetch('api/apple/' + path, data === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || '请求失败')
    return body
  }
  const buttons = []
  function button(text, action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text
    b.addEventListener('click', async () => {
      if (busy) return
      busy = true; buttons.forEach(x => { x.disabled = true })
      try { await action(); await refresh() }
      catch (error) { status.textContent = error.message }
      finally { busy = false; buttons.forEach(x => { x.disabled = false }) }
    })
    actions.appendChild(b); buttons.push(b); return b
  }
  button('1. 授权日历访问', async () => {
    await request('authorize', {})
    status.textContent = '请在 macOS 弹窗中允许完整日历访问。允许后点击「刷新状态」。'
  })
  button('刷新状态', async () => {})
  button('2. 启用双向同步', async () => {
    await window.ticklistApple?.beforeSync()
    if (!snapshot?.authorized) throw new Error('请先完成 macOS 授权。')
    await request('configure', { enabled: true, sourceID: sources.value })
    await window.ticklistApple?.refresh()
  })
  button('立即同步', async () => {
    await window.ticklistApple?.beforeSync()
    await request('sync', {})
    await window.ticklistApple?.refresh()
  })
  button('暂停同步', async () => { await request('configure', { enabled: false }) })
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'
  close.addEventListener('click', () => dialog.close()); actions.appendChild(close)
  async function refresh() {
    snapshot = await request('status')
    const selected = sources.value
    sources.replaceChildren()
    for (const source of snapshot.sources || []) {
      const option = document.createElement('option')
      option.value = source.id || source.sourceID
      option.textContent = source.title || source.name || option.value
      sources.appendChild(option)
    }
    if (snapshot.sourceID || selected) sources.value = snapshot.sourceID || selected
    const lines = [
      '权限：' + (snapshot.authorized ? '已允许' : snapshot.authorization || '尚未授权'),
      '同步：' + (snapshot.enabled ? snapshot.running ? '同步中…' : '已启用' : '未启用 / 已暂停'),
      '上次成功：' + (snapshot.lastRun ? new Date(snapshot.lastRun).toLocaleString() : '尚未同步'),
    ]
    if (snapshot.error || snapshot.lastError) lines.push('错误：' + (snapshot.error || snapshot.lastError))
    if (snapshot.authorized && !sources.options.length) lines.push('未发现可写 iCloud/CalDAV 账户。请先在系统设置中开启 iCloud 日历。')
    if (snapshot.conflicts?.length) {
      lines.push('待处理冲突：' + snapshot.conflicts.length + '（原始内容已保留；可先暂停同步，再核对两端修改）')
      snapshot.conflicts.slice(0, 8).forEach(c => lines.push(JSON.stringify(c)))
    }
    if (snapshot.warnings?.length) lines.push('提示：' + snapshot.warnings.slice(0, 5).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n'))
    status.textContent = lines.join('\n')
    sources.disabled = !!snapshot.calendarID
  }
  entry.addEventListener('click', () => {
    if (!dialog.isConnected) document.body.appendChild(dialog)
    dialog.showModal(); status.textContent = '正在检查桥接与权限…'
    void refresh().catch(error => { status.textContent = error.message })
    refreshTimer = setInterval(() => { if (!busy) void refresh().catch(() => {}) }, 10000)
  })
  dialog.addEventListener('close', () => { clearInterval(refreshTimer); entry.focus() })
})()
