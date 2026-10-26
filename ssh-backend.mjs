import { spawn } from 'node:child_process'
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
export function remoteCall(config, request) {
  return new Promise((resolve, reject) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(config.sshUser || '') || !/^[a-zA-Z0-9.-]+$/.test(config.sshHost || '')) return reject(new Error('日历 SSH 配置无效'))
    if (!config.sshIdentity || !config.remoteNode || !config.remoteRoot) return reject(new Error('缺少日历远程配置'))
    const command = `env NODE_NO_WARNINGS=1 ${quote(config.remoteNode)} ${quote(config.remoteRoot + '/remote-rpc.mjs')}`
    const child = spawn('/usr/bin/ssh', ['-T', '-i', config.sshIdentity,
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', `${config.sshUser}@${config.sshHost}`, command],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', finished = false
    const done = (error, result) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (error) { child.kill('SIGTERM'); reject(error) } else resolve(result)
    }
    const timer = setTimeout(() => done(new Error('连接 Mini 超时，未回退本机数据')), 12000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 4 * 1024 * 1024) done(new Error('Mini 返回的数据过大')) })
    child.stderr.on('data', () => {}) // No customer/task contents or SSH diagnostics in API output.
    child.stdin.on('error', error => done(error))
    child.on('error', error => done(error))
    child.on('close', code => {
      if (code !== 0) return done(new Error('无法连接 Mini，请检查 Tailscale、SSH 和日历插件'))
      try {
        const result = JSON.parse(output)
        if (!result || !Number.isInteger(result.status) || !result.body) throw new Error()
        done(null, result)
      } catch { done(new Error('Mini 日历响应无效，已停止读写')) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
