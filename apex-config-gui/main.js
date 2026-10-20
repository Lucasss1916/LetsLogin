'use strict'
// Electron 主进程: 窗口(自绘标题栏, 无系统边框)、系统对话框、IPC 分发; 配置逻辑在 backend.js, 广场 HTTP 在 plaza.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const backend = require('./backend')
const plaza = require('./plaza')

let mainWindow = null

function sendWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('apex:win-state', { maximized: mainWindow.isMaximized() })
  }
}

const handlers = {
  appInfo: () => ({ version: backend.ToolVersion, platform: process.platform }),
  detectDirs: () => backend.candidateDirs(),
  resolveDir: (payload = {}) => backend.resolveDir(payload.explicit, !!payload.createDir),
  readDetail: (payload = {}) => backend.readDetail(payload),
  listBackups: (payload = {}) => backend.listBackups(payload),
  backup: (payload = {}) => backend.backup(payload),
  restore: (payload = {}) => backend.restoreZip(payload),
  exportConfig: (payload = {}) => backend.exportConfig(payload),
  importShare: (payload = {}) => backend.importShare(payload),
  shareInfo: (payload = {}) => backend.shareInfo(payload),

  // 分享广场(HTTP 均在主进程发起, 不受渲染层 CORS 限制)
  'plaza:login': (payload = {}) => plaza.login(payload.base, payload.username, payload.password),
  'plaza:list': (payload = {}) => plaza.listConfigs(payload.base, payload.token, payload),
  'plaza:get': (payload = {}) => plaza.getConfig(payload.base, payload.token, payload.id, !!payload.count),
  'plaza:delete': (payload = {}) => plaza.deleteConfig(payload.base, payload.token, payload.id),
  'plaza:publish': (payload = {}) => {
    const { base, token, title, notes, sharePath, dir } = payload
    let raw = ''
    if (sharePath) {
      raw = fs.readFileSync(sharePath, 'utf8')
    }
    else {
      const built = backend.buildSharePayload({ dir, label: title, note: notes })
      raw = JSON.stringify(built.payload)
    }
    return plaza.publishConfig(base, token, { title, notes, payload: raw })
  },
  'plaza:download': (payload = {}) => {
    // 详情接口 ?count=1 计入下载次数; payload 即 .apexcfg 正文
    return plaza.getConfig(payload.base, payload.token, payload.id, true)
      .then(({ config }) => {
        fs.writeFileSync(payload.savePath, config.payload + '\n', 'utf8')
        return { ok: true, path: payload.savePath, label: config.title }
      })
  },
  'plaza:import': (payload = {}) => {
    // 广场"一键导入": 拉取详情 → 走与本地导入完全相同的校验/安全包流程
    return plaza.getConfig(payload.base, payload.token, payload.id, true)
      .then(({ config }) => backend.importPayload({ raw: config.payload, dir: payload.dir }))
      .then((result) => ({ ...result, from: '分享广场' }))
  },
}

ipcMain.handle('apex:op', async (_event, op, payload) => {
  const handler = handlers[op]
  if (!handler) throw new Error(`未知操作: ${op}`)
  return handler(payload || {})
})

// 窗口控制(自绘标题栏)
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize())
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  sendWindowState()
})
ipcMain.on('win:close', () => mainWindow && mainWindow.close())

ipcMain.handle('apex:pick-save', async (_event, opts = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, opts)
  return result.canceled ? null : result.filePath
})

ipcMain.handle('apex:pick-open', async (_event, opts = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], ...opts })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('apex:open-path', async (_event, target) => {
  const full = backend.openPath(target)
  return shell.openPath(full)
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0B0F17',
    frame: false,               // 隐藏系统标题栏(最小化/最大化/关闭), 由 renderer 自绘
    thickFrame: true,           // Windows 上保留可拖拽缩放的边缘与投影
    autoHideMenuBar: true,
    title: 'Apex 配置工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
