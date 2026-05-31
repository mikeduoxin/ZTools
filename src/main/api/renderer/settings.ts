import { app, globalShortcut, ipcMain, nativeTheme } from 'electron'
import type { PluginManager } from '../../managers/pluginManager'
import clipboardManager from '../../managers/clipboardManager.js'

// 共享API（主程序和插件都能用）
import { WindowManager as NativeWindowManager } from '../../core/native/index.js'
import { getCurrentShortcut, updateShortcut } from '../../index.js'

import doubleTapManager from '../../core/doubleTapManager.js'
import proxyManager from '../../managers/proxyManager.js'
import windowManager from '../../managers/windowManager.js'
import type { GlobalShortcutPreparation } from '../index'
import api from '../index'
import databaseAPI from '../shared/database'

const GLOBAL_SHORTCUT_COOLDOWN_MS = 180
const KEY_RELEASE_WAIT_TIMEOUT_MS = 1000
const CLIPBOARD_COPY_WAIT_TIMEOUT_MS = 1500

/**
 * 快捷键触发时携带的文件输入
 */
interface ShortcutInputFile {
  path: string
  name: string
  isDirectory: boolean
  isFile?: boolean
}

/**
 * 快捷键触发启动链路时使用的输入上下文
 */
interface ShortcutLaunchContext {
  searchQuery: string
  pastedImage: string | null
  pastedFiles: ShortcutInputFile[] | null
  pastedText: string | null
}

/**
 * 设置管理API - 主程序专用
 * 包含主题、快捷键、开机启动等设置
 */
export class SettingsAPI {
  private mainWindow: Electron.BrowserWindow | null = null
  private pluginManager: PluginManager | null = null

  public init(mainWindow: Electron.BrowserWindow, pluginManager: PluginManager): void {
    this.mainWindow = mainWindow
    this.pluginManager = pluginManager
    this.setupIPC()
    this.loadAndApplySettings()
  }

  // 临时快捷键录制相关
  private recordingShortcuts: string[] = []
  private lastGlobalShortcutTriggeredAt = new Map<string, number>()
  private globalShortcutKeyboardStateReleasers = new Map<string, () => void>()

  private setupIPC(): void {
    // 主题
    ipcMain.handle('set-theme', (_event, theme: string) => this.setTheme(theme))

    // 开机启动
    ipcMain.handle('set-launch-at-login', (_event, enable: boolean) =>
      this.setLaunchAtLogin(enable)
    )
    ipcMain.handle('get-launch-at-login', () => this.getLaunchAtLogin())

    // 快捷键
    ipcMain.handle('update-shortcut', (_event, shortcut: string) => this.updateShortcut(shortcut))
    ipcMain.handle('get-current-shortcut', () => this.getCurrentShortcut())
    ipcMain.handle('register-global-shortcut', (_event, shortcut: string, target: string) =>
      this.registerGlobalShortcut(shortcut, target)
    )
    ipcMain.handle('unregister-global-shortcut', (_event, shortcut: string) =>
      this.unregisterGlobalShortcut(shortcut)
    )

    // 应用快捷键
    ipcMain.handle('register-app-shortcut', (_event, shortcut: string, target: string) =>
      this.registerAppShortcut(shortcut, target)
    )
    ipcMain.handle('unregister-app-shortcut', (_event, shortcut: string) =>
      this.unregisterAppShortcut(shortcut)
    )

    // 临时快捷键录制
    ipcMain.handle('start-hotkey-recording', () => this.startHotkeyRecording())
  }

  // 加载并应用设置
  private async loadAndApplySettings(): Promise<void> {
    try {
      const data = databaseAPI.dbGet('settings-general')
      console.log('[Settings] 加载到的设置:', data)
      // 应用托盘图标显示设置（默认显示，在 if(data) 块外确保首次启动也能创建托盘）
      windowManager.setTrayIconVisible(data?.showTrayIcon ?? true)
      console.log('[Settings] 启动时应用托盘图标显示设置:', data?.showTrayIcon ?? true)

      if (data) {
        // 应用透明度设置
        if (data.opacity !== undefined && this.mainWindow) {
          const clampedOpacity = Math.max(0.3, Math.min(1, data.opacity))
          this.mainWindow.setOpacity(clampedOpacity)
          console.log('[Settings] 启动时应用透明度设置:', data.opacity)
        }
        // 应用快捷键设置
        if (data.hotkey) {
          const success = updateShortcut(data.hotkey)
          console.log('[Settings] 启动时应用快捷键设置:', data.hotkey, success ? '成功' : '失败')
        }
        // 应用主题设置
        if (data.theme) {
          this.setTheme(data.theme)
          console.log('[Settings] 启动时应用主题设置:', data.theme)
        }
        // 应用自动返回搜索设置
        if (data.autoBackToSearch) {
          await windowManager.updateAutoBackToSearch(data.autoBackToSearch)
          console.log('[Settings] 启动时应用自动返回搜索设置:', data.autoBackToSearch)
        }
        // 应用代理配置
        if (data.proxyEnabled !== undefined && data.proxyUrl !== undefined) {
          proxyManager.setProxyConfig({
            enabled: data.proxyEnabled,
            url: data.proxyUrl
          })
          // 应用全局代理
          await proxyManager.applyProxyToDefaultSession()
          console.log('[Settings] 启动时应用代理配置:', {
            enabled: data.proxyEnabled,
            url: data.proxyUrl
          })
        }
        // 应用窗口默认高度设置
        if (data.windowDefaultHeight !== undefined) {
          this.pluginManager?.setPluginDefaultHeight(data.windowDefaultHeight)
          console.log('[Settings] 启动时应用插件默认高度设置:', data.windowDefaultHeight)
        }
      }

      // 窗口位置现在由 windowManager.moveWindowToCursor() 处理
      // 每个显示器会自动恢复该显示器上次保存的位置

      // 加载并注册全局快捷键
      await this.loadAndRegisterGlobalShortcuts()
      // 加载并注册应用快捷键
      await this.loadAndRegisterAppShortcuts()
    } catch (error) {
      console.error('[Settings] 加载设置失败:', error)
    }
  }

  // 加载并注册全局快捷键
  private async loadAndRegisterGlobalShortcuts(): Promise<void> {
    try {
      const shortcuts = databaseAPI.dbGet('global-shortcuts')
      if (shortcuts && Array.isArray(shortcuts)) {
        for (const shortcut of shortcuts) {
          if (shortcut.enabled && shortcut.shortcut && shortcut.target) {
            try {
              await this.registerGlobalShortcut(shortcut.shortcut, shortcut.target)
            } catch (error) {
              console.error(`注册全局快捷键失败: ${shortcut.shortcut}`, error)
            }
          }
        }
      }
    } catch (error) {
      console.error('[Settings] 加载全局快捷键失败:', error)
    }
  }

  // 加载并注册应用快捷键
  private async loadAndRegisterAppShortcuts(): Promise<void> {
    try {
      const shortcuts = databaseAPI.dbGet('app-shortcuts')
      if (shortcuts && Array.isArray(shortcuts)) {
        for (const shortcut of shortcuts) {
          if (shortcut.enabled && shortcut.shortcut && shortcut.target) {
            try {
              this.registerAppShortcut(shortcut.shortcut, shortcut.target)
            } catch (error) {
              console.error(`注册应用快捷键失败: ${shortcut.shortcut}`, error)
            }
          }
        }
      }
    } catch (error) {
      console.error('[Settings] 加载应用快捷键失败:', error)
    }
  }

  // 设置主题
  public setTheme(theme: string): void {
    nativeTheme.themeSource = theme as 'system' | 'light' | 'dark'
    console.log('[Settings] 设置主题:', theme)
  }

  // 设置开机启动
  public setLaunchAtLogin(enable: boolean): void {
    app.setLoginItemSettings({
      openAtLogin: enable,
      openAsHidden: true
    })
    console.log('[Settings] 设置开机启动:', enable)
  }

  // 获取开机启动状态
  public getLaunchAtLogin(): boolean {
    const settings = app.getLoginItemSettings()
    return settings.openAtLogin
  }

  // 更新快捷键
  public updateShortcut(shortcut: string): { success: boolean; error?: string } {
    try {
      const success = updateShortcut(shortcut)
      if (success) {
        return { success: true }
      } else {
        return { success: false, error: '快捷键已被占用' }
      }
    } catch (error: unknown) {
      console.error('[Settings] 更新快捷键失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取当前快捷键
  private getCurrentShortcut(): string {
    return getCurrentShortcut()
  }

  private static readonly MODIFIER_NAMES = ['Command', 'Ctrl', 'Alt', 'Option', 'Shift']

  // 判断是否为双击修饰键快捷键（如 "Command+Command"）
  private isDoubleTapShortcut(shortcut: string): boolean {
    const parts = shortcut.split('+')
    return (
      parts.length === 2 && parts[0] === parts[1] && SettingsAPI.MODIFIER_NAMES.includes(parts[0])
    )
  }

  // 从双击快捷键字符串中提取修饰键名称
  private getDoubleTapModifier(shortcut: string): string {
    return shortcut.split('+')[0]
  }

  /**
   * 注册全局快捷键。
   * 触发时会按需采集当前外部应用中的选中文本，再把上下文交给上层统一处理。
   */
  public async registerGlobalShortcut(shortcut: string, target: string): Promise<any> {
    try {
      this.ensureGlobalShortcutKeyboardState(shortcut)
      const preparation = await api.prepareGlobalShortcut(target)

      if (this.isDoubleTapShortcut(shortcut)) {
        const modifier = this.getDoubleTapModifier(shortcut)
        doubleTapManager.unregister(modifier)
        doubleTapManager.register(modifier, () => {
          console.log(`双击修饰键触发: ${shortcut} -> ${target}`)
          void this.triggerGlobalShortcut(preparation)
        })
        console.log(`成功注册双击修饰键快捷键: ${shortcut} -> ${target}`)
        return { success: true }
      }

      // 先尝试取消注册该快捷键（如果已被注册），避免重复注册导致失败
      globalShortcut.unregister(shortcut)

      const success = globalShortcut.register(shortcut, () => {
        console.log(`全局快捷键触发: ${shortcut} -> ${target}`)
        void this.triggerGlobalShortcut(preparation)
      })

      if (!success) {
        this.releaseGlobalShortcutKeyboardState(shortcut)
        return { success: false, error: '快捷键注册失败，可能已被其他应用占用' }
      }

      console.log(`成功注册全局快捷键: ${shortcut} -> ${target}`)
      return { success: true }
    } catch (error: unknown) {
      this.releaseGlobalShortcutKeyboardState(shortcut)
      console.error('[Settings] 注册全局快捷键失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 注销全局快捷键
  public unregisterGlobalShortcut(shortcut: string): any {
    try {
      this.releaseGlobalShortcutKeyboardState(shortcut)

      if (this.isDoubleTapShortcut(shortcut)) {
        const modifier = this.getDoubleTapModifier(shortcut)
        doubleTapManager.unregister(modifier)
        console.log(`成功注销双击修饰键快捷键: ${shortcut}`)
        return { success: true }
      }

      globalShortcut.unregister(shortcut)
      console.log(`成功注销全局快捷键: ${shortcut}`)
      return { success: true }
    } catch (error: unknown) {
      console.error('[Settings] 注销全局快捷键失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 为已注册的全局快捷键持有键盘状态监听。
   * 这样触发时可以直接读取完整的按键释放状态，不必临时启动监听。
   */
  private ensureGlobalShortcutKeyboardState(shortcut: string): void {
    this.releaseGlobalShortcutKeyboardState(shortcut)
    this.globalShortcutKeyboardStateReleasers.set(shortcut, doubleTapManager.acquireKeyboardState())
  }

  /**
   * 释放某个全局快捷键持有的键盘状态监听引用。
   */
  private releaseGlobalShortcutKeyboardState(shortcut: string): void {
    const release = this.globalShortcutKeyboardStateReleasers.get(shortcut)
    if (!release) {
      return
    }

    release()
    this.globalShortcutKeyboardStateReleasers.delete(shortcut)
  }

  /**
   * 处理全局快捷键的统一触发入口。
   * 仅在目标命令需要文本上下文时才会执行复制取词，避免无关快捷键产生副作用。
   */
  private async triggerGlobalShortcut(preparation: GlobalShortcutPreparation): Promise<void> {
    if (!this.shouldTriggerGlobalShortcut(preparation.target)) {
      return
    }

    const context = preparation.shouldCaptureSelectedText
      ? await this.captureSelectedTextContext()
      : undefined
    await this.handleGlobalShortcut(preparation.target, context)
  }

  /**
   * 判断某个快捷键目标是否允许在阻断期内再次触发。
   * 同一 target 在 180ms 内只会放行一次。
   */
  private shouldTriggerGlobalShortcut(target: string): boolean {
    const now = Date.now()
    const lastTriggeredAt = this.lastGlobalShortcutTriggeredAt.get(target) ?? 0
    if (now - lastTriggeredAt < GLOBAL_SHORTCUT_COOLDOWN_MS) {
      return false
    }

    this.lastGlobalShortcutTriggeredAt.set(target, now)
    for (const [cachedTarget, timestamp] of this.lastGlobalShortcutTriggeredAt.entries()) {
      if (now - timestamp >= GLOBAL_SHORTCUT_COOLDOWN_MS) {
        this.lastGlobalShortcutTriggeredAt.delete(cachedTarget)
      }
    }
    return true
  }

  /**
   * 获取当前选中文本并转换成快捷键启动上下文。
   * 会等待触发快捷键的按键全部弹起后再执行复制，避免修饰键残留改变复制组合键。
   */
  private async captureSelectedTextContext(): Promise<ShortcutLaunchContext> {
    try {
      await doubleTapManager.waitForAllKeysReleased(KEY_RELEASE_WAIT_TIMEOUT_MS)

      const lastSequence = clipboardManager.getLastCopiedSequence()
      const modifier = process.platform === 'darwin' ? 'meta' : 'ctrl'
      NativeWindowManager.simulateKeyboardTap('c', modifier)

      const lastCopiedContent = await clipboardManager.waitForNextCopiedContent(
        lastSequence,
        CLIPBOARD_COPY_WAIT_TIMEOUT_MS
      )

      if (lastCopiedContent?.type === 'text' && typeof lastCopiedContent.data === 'string') {
        const text = lastCopiedContent.data
        if (text.trim()) {
          return {
            searchQuery: text,
            pastedImage: null,
            pastedFiles: null,
            pastedText: text
          }
        }
      }
    } catch (error) {
      console.error('[Settings] 获取选中文本失败:', error)
    }

    return {
      searchQuery: '',
      pastedImage: null,
      pastedFiles: null,
      pastedText: null
    }
  }

  /**
   * 处理全局快捷键触发。
   * 兼容普通全局快捷键和双击修饰键快捷键，统一向上层传递目标与上下文。
   */
  private async handleGlobalShortcut(
    target: string,
    context?: ShortcutLaunchContext
  ): Promise<void> {
    if (this.onGlobalShortcutTriggered) {
      await this.onGlobalShortcutTriggered(target, context)
    }
  }

  // 外部回调（由 APIManager 设置）
  private onGlobalShortcutTriggered?: (
    target: string,
    context?: ShortcutLaunchContext
  ) => void | Promise<void>

  /**
   * 设置全局快捷键触发后的统一回调。
   * 上层可根据目标命令和上下文完成最终启动。
   */
  public setGlobalShortcutHandler(
    handler: (target: string, context?: ShortcutLaunchContext) => void | Promise<void>
  ): void {
    this.onGlobalShortcutTriggered = handler
  }

  // 开始快捷键录制（注册临时快捷键监听）
  public startHotkeyRecording(): { success: boolean; error?: string } {
    try {
      // 如果已经在录制，先注销之前的临时快捷键
      if (this.recordingShortcuts.length > 0) {
        this.cleanupRecordingShortcuts()
      }

      // 定义需要临时注册的快捷键（常见的快捷键组合）
      const commonShortcuts = ['Alt+Space', 'Option+Space']

      // 注册所有快捷键
      for (const shortcut of commonShortcuts) {
        try {
          const success = globalShortcut.register(shortcut, () => {
            // 快捷键被触发，发送到设置插件
            console.log(`临时快捷键触发: ${shortcut}`)

            // 获取设置插件的 webContents 并发送事件
            if (this.pluginManager) {
              const settingWebContents = this.pluginManager.getPluginWebContentsByName('setting')
              if (settingWebContents) {
                settingWebContents.send('hotkey-recorded', shortcut)
              } else {
                console.warn('[Settings] 设置插件未找到，无法发送快捷键录制事件')
              }
            }

            // 立即注销所有临时快捷键（只能触发一次）
            this.cleanupRecordingShortcuts()
          })

          if (success) {
            this.recordingShortcuts.push(shortcut)
            console.log(`成功注册临时快捷键: ${shortcut}`)
          } else {
            console.warn(`临时快捷键注册失败（可能已被占用）: ${shortcut}`)
          }
        } catch (error) {
          console.error(`注册临时快捷键失败: ${shortcut}`, error)
        }
      }

      console.log(`开始快捷键录制，已注册 ${this.recordingShortcuts.length} 个临时快捷键`)
      return { success: true }
    } catch (error: unknown) {
      console.error('[Settings] 开始快捷键录制失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 清理临时快捷键（内部方法）
  private cleanupRecordingShortcuts(): void {
    for (const shortcut of this.recordingShortcuts) {
      try {
        globalShortcut.unregister(shortcut)
        console.log(`成功注销临时快捷键: ${shortcut}`)
      } catch (error) {
        console.error(`注销临时快捷键失败: ${shortcut}`, error)
      }
    }

    const count = this.recordingShortcuts.length
    this.recordingShortcuts = []
    console.log(`已清理 ${count} 个临时快捷键`)
  }

  // 设置代理配置
  public async setProxyConfig(config: {
    enabled: boolean
    url: string
  }): Promise<{ success: boolean; error?: string }> {
    try {
      proxyManager.setProxyConfig(config)
      console.log('[Settings] 代理配置已更新:', config)

      // 应用全局代理配置
      await proxyManager.applyProxyToDefaultSession()

      return { success: true }
    } catch (error: unknown) {
      console.error('[Settings] 设置代理配置失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 设置窗口默认高度
  public setWindowDefaultHeight(height: number): { success: boolean; error?: string } {
    try {
      this.pluginManager?.setPluginDefaultHeight(height)
      console.log('[Settings] 插件默认高度已更新:', height)
      return { success: true }
    } catch (error: unknown) {
      console.error('[Settings] 设置插件默认高度失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 注册应用快捷键
  public registerAppShortcut(shortcut: string, target: string): any {
    try {
      const success = windowManager.registerAppShortcut(shortcut, target)
      if (!success) {
        return { success: false, error: '应用快捷键注册失败' }
      }
      return { success: true }
    } catch (error: unknown) {
      console.error('[Settings] 注册应用快捷键失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 注销应用快捷键
  public unregisterAppShortcut(shortcut: string): any {
    try {
      windowManager.unregisterAppShortcut(shortcut)
      console.log(`成功注销应用快捷键: ${shortcut}`)
      return { success: true }
    } catch (error: unknown) {
      console.error('[Settings] 注销应用快捷键失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }
}

export default new SettingsAPI()
