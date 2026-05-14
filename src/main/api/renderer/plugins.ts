import type { PluginManager } from '../../managers/pluginManager'
import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { normalizeIconPath } from '../../common/iconUtils'
import { isBundledInternalPlugin } from '../../core/internalPlugins'
import lmdbInstance from '../../core/lmdb/lmdbInstance'
import windowManager from '../../managers/windowManager'
import { httpGet } from '../../utils/httpRequest.js'
import { pluginFeatureAPI } from '../plugin/feature'
import webSearchAPI from './webSearch'
import databaseAPI from '../shared/database'
import { PluginDevProjectsAPI } from './pluginDevProjects'
import { PluginInstallerAPI } from './pluginInstaller'
import { PluginMarketAPI } from './pluginMarket'
import {
  getPluginDataPrefix,
  isDevelopmentPluginName
} from '../../../shared/pluginRuntimeNamespace'

// 插件目录
const DISABLED_PLUGINS_KEY = 'disabled-plugins'

export interface DeletePluginOptions {
  deleteData?: boolean
}

/**
 * 插件管理API - 主程序专用
 */
export class PluginsAPI {
  private mainWindow: Electron.BrowserWindow | null = null
  private pluginManager: PluginManager | null = null
  private disabledPluginPathSet: Set<string> | null = null
  public devProjects!: PluginDevProjectsAPI
  public installer!: PluginInstallerAPI
  public market!: PluginMarketAPI

  public init(mainWindow: Electron.BrowserWindow, pluginManager: PluginManager): void {
    this.mainWindow = mainWindow
    this.pluginManager = pluginManager
    this.devProjects = new PluginDevProjectsAPI({
      get mainWindow() {
        return mainWindow
      },
      get pluginManager() {
        return pluginManager
      },
      readInstalledPlugins: () => this.readInstalledPlugins(),
      writeInstalledPlugins: (plugins) => this.writeInstalledPlugins(plugins),
      notifyPluginsChanged: () => this.notifyPluginsChanged(),
      validatePluginConfig: (config, existing) => this.validatePluginConfig(config, existing),
      resolvePluginLogo: (p, logo) => this.resolvePluginLogo(p, logo),
      getRunningPlugins: () => this.getRunningPlugins()
    })
    this.market = new PluginMarketAPI()
    this.installer = new PluginInstallerAPI({
      get mainWindow() {
        return mainWindow
      },
      get pluginManager() {
        return pluginManager
      },
      get devProjects() {
        return pluginsAPI.devProjects
      },
      getPlugins: () => this.getPlugins(),
      readInstalledPlugins: () => this.readInstalledPlugins(),
      writeInstalledPlugins: (plugins) => this.writeInstalledPlugins(plugins),
      notifyPluginsChanged: () => this.notifyPluginsChanged(),
      validatePluginConfig: (config, existing) => this.validatePluginConfig(config, existing)
    })
    this.setupIPC()
  }

  private setupIPC(): void {
    ipcMain.handle('get-plugins', () => this.getPlugins())
    ipcMain.handle('get-all-plugins', () => this.getAllPlugins())
    ipcMain.handle('get-disabled-plugins', () => this.getDisabledPlugins())
    ipcMain.handle('set-plugin-disabled', (_event, pluginPath: string, disabled: boolean) =>
      this.setPluginDisabled(pluginPath, disabled)
    )
    ipcMain.handle('import-plugin', () => this.installer.importPlugin())
    ipcMain.handle('import-dev-plugin', (_event, pluginJsonPath?: string) =>
      this.devProjects.importDevPlugin(pluginJsonPath)
    )
    ipcMain.handle('upsert-dev-project-by-config-path', (_event, pluginJsonPath: string) =>
      this.devProjects.upsertDevProjectByConfigPath(pluginJsonPath)
    )
    ipcMain.handle('get-dev-projects', () => this.devProjects.getDevProjects())
    ipcMain.handle('update-dev-projects-order', (_event, pluginNames: string[]) =>
      this.devProjects.updateDevProjectsOrder(pluginNames)
    )
    ipcMain.handle('remove-dev-project', (_event, pluginName: string) =>
      this.devProjects.removeDevProject(pluginName)
    )
    ipcMain.handle('install-dev-plugin', (_event, pluginName: string) =>
      this.devProjects.installDevPlugin(pluginName)
    )
    ipcMain.handle('uninstall-dev-plugin', (_event, pluginName: string) =>
      this.devProjects.uninstallDevPlugin(pluginName)
    )
    ipcMain.handle('validate-dev-project', (_event, pluginName: string) =>
      this.devProjects.validateDevProject(pluginName)
    )
    ipcMain.handle('select-dev-project-config', (_event, pluginName: string) =>
      this.devProjects.selectDevProjectConfig(pluginName)
    )
    ipcMain.handle(
      'package-dev-project',
      (_event, pluginName: string, packagePath?: string, version?: string) =>
        this.devProjects.packageDevProject(pluginName, packagePath, version)
    )
    ipcMain.handle('delete-plugin', (_event, pluginPath: string, options?: DeletePluginOptions) =>
      this.deletePlugin(pluginPath, options)
    )
    ipcMain.handle('get-running-plugins', () => this.getRunningPlugins())
    ipcMain.handle('kill-plugin', (_event, pluginPath: string) => this.killPlugin(pluginPath))
    ipcMain.handle('kill-plugin-and-return', (_event, pluginPath: string) =>
      this.killPluginAndReturn(pluginPath)
    )
    ipcMain.handle('fetch-plugin-market', () => this.market.fetchPluginMarket())
    ipcMain.handle('install-plugin-from-market', (event, plugin: any) =>
      this.installer.installPluginFromMarket(plugin, event.sender)
    )
    ipcMain.handle('cancel-plugin-market-download', (_event, pluginNameOrTaskId: string) =>
      this.installer.cancelPluginMarketDownload(pluginNameOrTaskId)
    )
    ipcMain.handle('get-plugin-readme', (_event, pluginPathOrName: string, pluginName?: string) =>
      this.getPluginReadme(pluginPathOrName, pluginName)
    )
    ipcMain.handle('get-plugin-db-data', (_event, pluginName: string) =>
      this.getPluginDbData(pluginName)
    )
    ipcMain.handle('read-plugin-info-from-zpx', (_event, zpxPath: string) =>
      this.installer.readPluginInfoFromZpx(zpxPath)
    )
    ipcMain.handle('install-plugin-from-path', (_event, zpxPath: string) =>
      this.installer.installPluginFromPath(zpxPath)
    )
    // mainPush 功能：查询插件的动态搜索结果
    ipcMain.handle(
      'query-main-push',
      async (_event, pluginPath: string, featureCode: string, queryData: any) => {
        try {
          if (this.isPluginDisabled(pluginPath)) {
            return []
          }
          return await this.pluginManager?.queryMainPush(pluginPath, featureCode, queryData)
        } catch (error: unknown) {
          console.error('[Plugins] mainPush 查询失败:', error)
          return []
        }
      }
    )

    // mainPush 功能：通知插件用户选择了搜索结果
    ipcMain.handle(
      'select-main-push',
      async (_event, pluginPath: string, featureCode: string, selectData: any) => {
        try {
          if (this.isPluginDisabled(pluginPath)) {
            return false
          }
          return await this.pluginManager?.selectMainPush(pluginPath, featureCode, selectData)
        } catch (error: unknown) {
          console.error('[Plugins] mainPush 选择失败:', error)
          return false
        }
      }
    )

    ipcMain.handle(
      'call-headless-plugin',
      async (_event, pluginPath: string, featureCode: string, action: any) => {
        try {
          if (this.isPluginDisabled(pluginPath)) {
            return { success: false, error: '插件已禁用' }
          }
          const result = await this.pluginManager?.callHeadlessPluginMethod(
            pluginPath,
            featureCode,
            action
          )
          return { success: true, result }
        } catch (error: unknown) {
          console.error('[Plugins] 调用无界面插件失败:', error)
          return { success: false, error: error instanceof Error ? error.message : '未知错误' }
        }
      }
    )

    ipcMain.handle('get-plugin-memory-info', async (_event, pluginPath: string) => {
      try {
        const memoryInfo = await this.pluginManager?.getPluginMemoryInfo(pluginPath)
        return { success: true, data: memoryInfo }
      } catch (error: unknown) {
        console.error('[Plugins] 获取插件内存信息失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '获取失败' }
      }
    })

    ipcMain.handle(
      'install-plugin-from-npm',
      (_event, options: { packageName: string; useChinaMirror?: boolean }) =>
        this.installer.installPluginFromNpm(options.packageName, options.useChinaMirror)
    )

    ipcMain.handle('export-all-plugins', () => this.installer.exportAllPlugins())
  }

  // 获取插件列表（过滤掉内置插件，用于插件中心显示）
  public async getPlugins(): Promise<any[]> {
    const allPlugins = await this.getAllPlugins()
    // 过滤掉所有内置插件（system、setting 等）
    return allPlugins.filter((plugin: any) => !isBundledInternalPlugin(plugin.name))
  }

  public getDisabledPlugins(): string[] {
    if (this.disabledPluginPathSet) {
      return [...this.disabledPluginPathSet]
    }

    const data = databaseAPI.dbGet(DISABLED_PLUGINS_KEY)
    const disabledPlugins = Array.isArray(data)
      ? data.filter((item): item is string => typeof item === 'string')
      : []

    this.disabledPluginPathSet = new Set(disabledPlugins)
    return disabledPlugins
  }

  public getDisabledPluginSet(): Set<string> {
    if (!this.disabledPluginPathSet) {
      this.getDisabledPlugins()
    }
    // getDisabledPlugins() 确保 disabledPluginPathSet 被初始化
    return this.disabledPluginPathSet!
  }

  public isPluginDisabled(pluginPath: string): boolean {
    return this.getDisabledPluginSet().has(pluginPath)
  }

  public async setPluginDisabled(
    pluginPath: string,
    disabled: boolean
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const plugins = databaseAPI.dbGet('plugins')
      if (!Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const plugin = plugins.find((item: any) => item.path === pluginPath)
      if (!plugin) {
        return { success: false, error: '插件不存在' }
      }
      if (isBundledInternalPlugin(plugin.name)) {
        return { success: false, error: '内置插件不能禁用' }
      }

      const disabledPlugins = this.getDisabledPluginSet()
      const isCurrentlyDisabled = disabledPlugins.has(pluginPath)
      if (isCurrentlyDisabled === disabled) {
        return { success: true }
      }

      if (disabled) {
        disabledPlugins.add(pluginPath)
      } else {
        disabledPlugins.delete(pluginPath)
      }
      this.disabledPluginPathSet = disabledPlugins
      databaseAPI.dbPut(DISABLED_PLUGINS_KEY, [...disabledPlugins])

      if (disabled && this.pluginManager) {
        this.pluginManager.killPlugin(pluginPath)
      }

      this.mainWindow?.webContents.send('plugins-changed')
      this.mainWindow?.webContents.send('super-panel-pinned-changed')
      return { success: true }
    } catch (error: unknown) {
      console.error('[Plugins] 更新插件禁用状态失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取所有插件列表（包括 system 插件，用于生成搜索指令）
  public async getAllPlugins(): Promise<any[]> {
    try {
      const data = databaseAPI.dbGet('plugins')
      const plugins = data || []

      // 合并动态 features 和网页快开搜索引擎
      const webSearchFeatures = await webSearchAPI.getSearchEngineFeatures()
      for (const plugin of plugins) {
        const dynamicFeatures = pluginFeatureAPI.loadDynamicFeatures(plugin.name)
        plugin.features = [...(plugin.features || []), ...dynamicFeatures]

        // 将网页快开搜索引擎作为系统插件的动态 features
        if (plugin.name === 'system' && webSearchFeatures.length > 0) {
          plugin.features = [...plugin.features, ...webSearchFeatures]
        }

        // 处理插件 logo 路径
        if (plugin.logo) {
          plugin.logo = normalizeIconPath(plugin.logo, plugin.path)
        }

        // 处理每个 feature 的 icon 路径
        if (plugin.features && Array.isArray(plugin.features)) {
          for (const feature of plugin.features) {
            if (feature.icon) {
              feature.icon = normalizeIconPath(feature.icon, plugin.path)
            }
          }
        }
      }

      return plugins
    } catch (error) {
      console.error('[Plugins] 获取插件列表失败:', error)
      return []
    }
  }

  private readInstalledPlugins(): any[] {
    const plugins = databaseAPI.dbGet('plugins')
    return Array.isArray(plugins) ? plugins : []
  }

  private writeInstalledPlugins(plugins: any[]): void {
    databaseAPI.dbPut('plugins', plugins)
  }

  private notifyPluginsChanged(): void {
    this.mainWindow?.webContents.send('plugins-changed')
  }

  /**
   * 验证插件配置
   * @param pluginConfig 插件配置对象
   * @param existingPlugins 已存在的插件列表
   * @returns 验证结果 { valid: boolean, error?: string }
   */
  private validatePluginConfig(
    pluginConfig: any,
    existingPlugins: any[]
  ): { valid: boolean; error?: string } {
    // 检查 title 是否冲突（如果有 title 字段）
    // 排除开发版插件（name 以 __dev 结尾），因为开发版和安装版可以共存，title 相同是合理的
    if (pluginConfig.title) {
      const titleConflict = existingPlugins.find(
        (p: any) => p.title === pluginConfig.title && !isDevelopmentPluginName(p.name)
      )
      if (titleConflict) {
        return {
          valid: false,
          error: `插件标题 "${pluginConfig.title}" 已被插件 "${titleConflict.name}" 使用，请使用不同的标题`
        }
      }
    }

    // 校验必填字段
    const requiredFields = ['name', 'version']
    for (const field of requiredFields) {
      if (!pluginConfig[field]) {
        return { valid: false, error: `缺少必填字段: ${field}` }
      }
    }

    // 检查插件是否声明了 features 或 tools（至少需要一个）
    const hasFeatures = Array.isArray(pluginConfig.features) && pluginConfig.features.length > 0
    const hasTools =
      pluginConfig.tools &&
      typeof pluginConfig.tools === 'object' &&
      !Array.isArray(pluginConfig.tools) &&
      Object.keys(pluginConfig.tools).length > 0

    // features 和 tools 不能同时为空
    if (!hasFeatures && !hasTools) {
      return { valid: false, error: 'features 和 tools 不能同时为空' }
    }

    // 校验 features 字段（传统插件功能）
    if (hasFeatures) {
      for (const feature of pluginConfig.features) {
        if (!feature.code || !Array.isArray(feature.cmds)) {
          return { valid: false, error: 'feature 缺少必填字段 (code, cmds)' }
        }
      }
    }

    // 校验 tools 字段（MCP 工具声明）
    if (hasTools) {
      for (const [toolName, tool] of Object.entries(pluginConfig.tools)) {
        // 工具名必须使用小写 snake_case 命名（符合 MCP 规范）
        if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
          return { valid: false, error: `tools.${toolName} 必须使用小写 snake_case 命名` }
        }
        if (!tool || typeof tool !== 'object') {
          return { valid: false, error: `tools.${toolName} 配置无效` }
        }
        // 必须提供工具描述
        if (typeof (tool as any).description !== 'string' || !(tool as any).description.trim()) {
          return { valid: false, error: `tools.${toolName}.description 必须是非空字符串` }
        }
        // 必须提供 JSON Schema 格式的输入参数定义
        if (
          !(tool as any).inputSchema ||
          typeof (tool as any).inputSchema !== 'object' ||
          Array.isArray((tool as any).inputSchema)
        ) {
          return { valid: false, error: `tools.${toolName}.inputSchema 必须是对象` }
        }
      }
    }

    // 无界面插件（仅声明 tools，没有 main）的额外校验
    if (!pluginConfig.main && hasTools) {
      if (!pluginConfig.preload) {
        return { valid: false, error: '声明 tools 的插件必须提供 preload' }
      }
      if (!pluginConfig.logo) {
        return { valid: false, error: '声明 tools 的插件必须提供 logo' }
      }
    }

    return { valid: true }
  }

  private resolvePluginLogo(pluginPath: string, logo: unknown): string {
    if (typeof logo !== 'string' || !logo) return ''
    if (/^(https?:|file:)/.test(logo)) return logo
    return pathToFileURL(path.join(pluginPath, logo)).href
  }

  /**
   * 删除插件
   * @param pluginPath 插件路径
   * @param options 删除选项 当 options.deleteData 显式设置为 false 时，保留插件数据
   */
  public async deletePlugin(pluginPath: string, options: DeletePluginOptions = {}): Promise<any> {
    try {
      const plugins: any = databaseAPI.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const pluginIndex = plugins.findIndex((p: any) => p.path === pluginPath)
      if (pluginIndex === -1) {
        return { success: false, error: '插件不存在' }
      }

      const pluginInfo = plugins[pluginIndex]

      // ✅ 检查是否为内置插件
      if (isBundledInternalPlugin(pluginInfo.name)) {
        return {
          success: false,
          error: '内置插件不能卸载'
        }
      }

      this.pluginManager?.killPlugin(pluginPath)

      plugins.splice(pluginIndex, 1)
      databaseAPI.dbPut('plugins', plugins)

      this.devProjects.removePluginUsageData(pluginInfo.name)

      if (options.deleteData !== false) {
        await databaseAPI.clearPluginData(pluginInfo.name)
      }

      // 删除禁用插件标识
      const disabledPlugins = this.getDisabledPluginSet()
      if (disabledPlugins.delete(pluginPath)) {
        this.disabledPluginPathSet = disabledPlugins
        databaseAPI.dbPut(DISABLED_PLUGINS_KEY, [...disabledPlugins])
      }

      this.notifyPluginsChanged()

      if (!pluginInfo.isDevelopment) {
        try {
          await fs.rm(pluginPath, { recursive: true, force: true })
          console.log('[Plugins] 已删除插件目录:', pluginPath)
        } catch (error) {
          console.error('[Plugins] 删除插件目录失败:', error)
        }
      } else {
        console.log('[Plugins] 开发中插件，保留目录:', pluginPath)
      }

      return { success: true }
    } catch (error: unknown) {
      console.error('[Plugins] 删除插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取运行中的插件
  public getRunningPlugins(): string[] {
    if (this.pluginManager) {
      return this.pluginManager.getRunningPlugins()
    }
    return []
  }

  // 终止插件
  public killPlugin(pluginPath: string): { success: boolean; error?: string } {
    try {
      console.log('[Plugins] 终止插件:', pluginPath)
      if (this.pluginManager) {
        const result = this.pluginManager.killPlugin(pluginPath)
        if (result) {
          return { success: true }
        } else {
          return { success: false, error: '插件未运行' }
        }
      }
      return { success: false, error: '功能不可用' }
    } catch (error: unknown) {
      console.error('[Plugins] 终止插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 终止插件并返回搜索页面
  private killPluginAndReturn(pluginPath: string): { success: boolean; error?: string } {
    try {
      console.log('[Plugins] 终止插件并返回搜索页面:', pluginPath)
      if (this.pluginManager) {
        const result = this.pluginManager.killPlugin(pluginPath)
        if (result) {
          windowManager.notifyBackToSearch()
          this.mainWindow?.webContents.focus()
          return { success: true }
        } else {
          return { success: false, error: '插件未运行' }
        }
      }
      return { success: false, error: '功能不可用' }
    } catch (error: unknown) {
      console.error('[Plugins] 终止插件并返回搜索页面失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取插件 README.md 内容
  public async getPluginReadme(
    pluginPathOrName: string,
    pluginName?: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      // 如果 pluginPathOrName 是一个路径（包含 / 或 \），则读取本地文件
      if (pluginPathOrName.includes('/') || pluginPathOrName.includes('\\')) {
        return await this.getLocalPluginReadme(pluginPathOrName)
      }

      // 否则当作插件名称，从远程加载
      const name = pluginName || pluginPathOrName
      return await this.getRemotePluginReadme(name)
    } catch (error: unknown) {
      console.error('[Plugins] 读取插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  // 读取本地插件 README
  private async getLocalPluginReadme(
    pluginPath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      // 尝试不同的 README 文件名（大小写不敏感）
      const possibleReadmeFiles = ['README.md', 'readme.md', 'Readme.md', 'README.MD']

      for (const filename of possibleReadmeFiles) {
        const readmePath = path.join(pluginPath, filename)
        try {
          let content = await fs.readFile(readmePath, 'utf-8')

          // 将插件路径转换为 file:// URL（跨平台兼容）
          const pluginPathUrl = pathToFileURL(pluginPath).href

          // 替换 Markdown 图片语法：![alt](path)
          content = content.replace(
            /!\[([^\]]*)\]\((?!http|file:)([^)]+)\)/g,
            (_match, alt, imgPath) => {
              const cleanPath = imgPath.replace(/^\.\//, '')
              return `![${alt}](${pluginPathUrl}/${cleanPath})`
            }
          )

          // 替换 HTML img 标签的 src 属性
          content = content.replace(
            /<img([^>]*?)src=["'](?!http|file:)([^"']+)["']([^>]*?)>/gi,
            (_match, before, src, after) => {
              const cleanSrc = src.replace(/^\.\//, '')
              return `<img${before}src="${pluginPathUrl}/${cleanSrc}"${after}>`
            }
          )

          // 替换 Markdown 链接语法（排除锚点链接 #）
          content = content.replace(
            /\[([^\]]+)\]\((?!http|file:|#)([^)]+)\)/g,
            (_match, text, linkPath) => {
              const cleanPath = linkPath.replace(/^\.\//, '')
              return `[${text}](${pluginPathUrl}/${cleanPath})`
            }
          )

          // 替换 HTML a 标签的 href 属性（排除锚点链接和外部链接）
          content = content.replace(
            /<a([^>]*?)href=["'](?!http|file:|#)([^"']+)["']([^>]*?)>/gi,
            (_match, before, href, after) => {
              const cleanHref = href.replace(/^\.\//, '')
              return `<a${before}href="${pluginPathUrl}/${cleanHref}"${after}>`
            }
          )

          return { success: true, content }
        } catch {
          // 继续尝试下一个文件名
          continue
        }
      }

      // 所有文件名都不存在
      return { success: false, error: '暂无详情' }
    } catch (error: unknown) {
      console.error('[Plugins] 读取本地插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  // 从远程加载插件 README
  private async getRemotePluginReadme(
    pluginName: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const baseUrl = `https://raw.githubusercontent.com/ZToolsCenter/ZTools-plugins/main/plugins/${pluginName}`
      const readmeUrl = `${baseUrl}/README.md`

      console.log('[Plugins] 从远程加载 README:', readmeUrl)

      // 使用 httpGet 获取 README 内容（走系统代理）
      const response = await httpGet(readmeUrl, {
        validateStatus: (status) => status >= 200 && status < 400
      })
      if (response.status >= 300) {
        return { success: false, error: '暂无详情' }
      }

      let content =
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data)

      // 替换 Markdown 图片语法：![alt](path)
      content = content.replace(/!\[([^\]]*)\]\((?!http)([^)]+)\)/g, (_match, alt, imgPath) => {
        const cleanPath = imgPath.replace(/^\.\//, '')
        return `![${alt}](${baseUrl}/${cleanPath})`
      })

      // 替换 HTML img 标签的 src 属性
      content = content.replace(
        /<img([^>]*?)src=["'](?!http)([^"']+)["']([^>]*?)>/gi,
        (_match, before, src, after) => {
          const cleanSrc = src.replace(/^\.\//, '')
          return `<img${before}src="${baseUrl}/${cleanSrc}"${after}>`
        }
      )

      // 替换 Markdown 链接语法（排除锚点链接 #）
      content = content.replace(/\[([^\]]+)\]\((?!http|#)([^)]+)\)/g, (_match, text, linkPath) => {
        const cleanPath = linkPath.replace(/^\.\//, '')
        return `[${text}](${baseUrl}/${cleanPath})`
      })

      // 替换 HTML a 标签的 href 属性（排除锚点链接和外部链接）
      content = content.replace(
        /<a([^>]*?)href=["'](?!http|#)([^"']+)["']([^>]*?)>/gi,
        (_match, before, href, after) => {
          const cleanHref = href.replace(/^\.\//, '')
          return `<a${before}href="${baseUrl}/${cleanHref}"${after}>`
        }
      )

      return { success: true, content }
    } catch (error: unknown) {
      console.error('[Plugins] 从远程加载插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '加载失败' }
    }
  }

  // 获取插件存储的数据库数据
  private getPluginDbData(pluginName: string): {
    success: boolean
    data?: any
    error?: string
  } {
    try {
      if (pluginName === 'ZTOOLS') {
        const allData = lmdbInstance.allDocs('ZTOOLS/')
        return {
          success: true,
          data: allData.map((item: any) => ({
            id: item._id.substring('ZTOOLS/'.length),
            data: item.data,
            rev: item._rev,
            updatedAt: item.updatedAt || item._updatedAt
          }))
        }
      }

      if (!pluginName) {
        return { success: false, error: '插件标识无效' }
      }

      const prefix = getPluginDataPrefix(pluginName)
      const allData = lmdbInstance.allDocs(prefix)

      if (!allData || allData.length === 0) {
        return { success: true, data: [] }
      }

      const formattedData = allData.map((item: any) => ({
        id: item._id.substring(prefix.length),
        data: item.data,
        rev: item._rev,
        updatedAt: item.updatedAt || item._updatedAt
      }))

      return { success: true, data: formattedData }
    } catch (error: unknown) {
      console.error('[Plugins] 获取插件数据失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '获取失败' }
    }
  }
}

const pluginsAPI = new PluginsAPI()
export default pluginsAPI
