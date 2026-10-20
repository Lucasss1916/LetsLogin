'use strict'
// 渲染进程专用桥: invoke 通用操作 + 窗口控制, 不泄漏 Node 能力
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('apexApi', {
  invoke: (op, payload) => ipcRenderer.invoke('apex:op', op, payload),
  pickSave: (opts) => ipcRenderer.invoke('apex:pick-save', opts),
  pickOpen: (opts) => ipcRenderer.invoke('apex:pick-open', opts),
  openPath: (target) => ipcRenderer.invoke('apex:open-path', target),
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    onState: (callback) => ipcRenderer.on('apex:win-state', (_event, state) => callback(state)),
  },
})
