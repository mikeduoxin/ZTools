import yaml from 'yaml'
import { shuffleArray } from '../../utils/common.js'
import { httpGet } from '../../utils/httpRequest.js'
import databaseAPI from '../shared/database'

// ━━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 插件市场中单个插件的描述信息（来自远程 plugins.json） */
export type PluginMarketPlugin = {
  name: string
  version: string
  title?: string
  description?: string
  logo?: string
  /** 支持的平台列表，如 ['darwin', 'win32']；空表示全平台 */
  platform?: string[]
  /** 插件包的下载 URL */
  downloadUrl?: string
  [key: string]: unknown
}

/** 市场首页轮播图项 */
type PluginMarketBannerItem = {
  /** 轮播图图片 URL */
  image: string
  /** 点击跳转链接 */
  url?: string
}

/** 插件分类配置（来自远程 categories.json） */
type PluginMarketCategoryConfig = {
  /** 分类唯一标识 */
  key?: string
  /** 分类显示标题 */
  title?: string
  description?: string
  icon?: string
  /** 该分类下的插件名称列表 */
  list?: string[]
}

/** 首页布局区域配置（来自远程 layout.yaml） */
type PluginMarketLayoutSectionConfig = {
  /** 区域类型：banner / navigation / fixed / random */
  type?: string
  title?: string
  /** random 类型的插件数量 */
  count?: number
  /** banner 的高度（px） */
  height?: number
  /** navigation 是否显示分类描述 */
  showDescription?: boolean
  /** banner 子项 */
  children?: PluginMarketBannerItem[]
  /** navigation 引用的分类 key 列表 */
  categories?: string[]
  /** fixed 类型的插件名称列表 */
  plugins?: string[]
}

/** 分类详情页的布局区域配置 */
type PluginMarketCategoryLayoutSection = {
  /** 区域类型：list / fixed / random */
  type: string
  /** 支持模板字符串如 '${title}系列，共${count}个工具' */
  title?: string
  count?: number
  plugins?: string[]
}

/** 插件市场分类（构建后的视图数据） */
type PluginMarketStorefrontCategory = {
  key: string
  title: string
  description?: string
  icon?: string
  /** 该分类下的插件对象列表（已按平台过滤） */
  plugins: PluginMarketPlugin[]
}

/** 插件市场首页的单个布局区域（联合类型） */
type PluginMarketStorefrontSection =
  | {
      type: 'banner'
      key: string
      items: PluginMarketBannerItem[]
      height?: number
    }
  | {
      type: 'navigation'
      key: string
      title?: string
      categories: Array<{
        key: string
        title: string
        description?: string
        icon?: string
        showDescription: boolean
        pluginCount: number
      }>
    }
  | {
      type: 'fixed' | 'random'
      key: string
      title?: string
      plugins: PluginMarketPlugin[]
    }

/** 插件市场完整的首页视图数据 */
type PluginMarketStorefront = {
  /** 首页布局区域列表（按顺序渲染） */
  sections: PluginMarketStorefrontSection[]
  /** 所有分类的详细信息，以 key 为索引 */
  categories: Record<string, PluginMarketStorefrontCategory>
  /** 各分类详情页的布局配置 */
  categoryLayouts: Record<string, PluginMarketCategoryLayoutSection[]>
}

/** fetchPluginMarket 的返回结果 */
export type PluginMarketResult = {
  success: boolean
  /** 全量插件列表（原始数据，未按平台过滤） */
  data?: PluginMarketPlugin[]
  /** 构建好的首页视图数据（平台已过滤） */
  storefront?: PluginMarketStorefront
  error?: string
}

// ━━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** storefront 视图数据在 LMDB 中的缓存键 */
const PLUGIN_MARKET_STOREFRONT_CACHE_KEY = 'plugin-market-storefront'
/** storefront 指纹在 LMDB 中的缓存键，用于判断缓存是否失效 */
const PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY = 'plugin-market-storefront-fingerprint'

// ━━━ PluginMarketAPI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 插件市场 API。
 * 负责从远程获取插件列表、缓存管理和首页 storefront 视图数据构建。
 * 无外部依赖，仅使用 databaseAPI 和 httpGet。
 */
export class PluginMarketAPI {
  /**
   * 获取插件市场列表。
   * 缓存策略：
   * 1. 先通过 latest 文件检查版本号是否有更新
   * 2. 版本相同则直接返回本地缓存
   * 3. 网络失败时降级使用本地缓存
   * @returns 插件列表和可选的 storefront 视图数据
   */
  public async fetchPluginMarket(): Promise<PluginMarketResult> {
    const getCachedResult = (): PluginMarketResult | null => {
      const cachedData = databaseAPI.dbGet('plugin-market-data')
      if (!Array.isArray(cachedData)) {
        return null
      }

      const storefrontFingerprint = databaseAPI.dbGet(
        PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY
      )
      const cachedStorefront = databaseAPI.dbGet(PLUGIN_MARKET_STOREFRONT_CACHE_KEY)
      const currentFingerprint = this.getPluginMarketFingerprint(cachedData)
      const storefront =
        storefrontFingerprint === currentFingerprint && cachedStorefront
          ? cachedStorefront
          : undefined

      return {
        success: true,
        data: cachedData,
        ...(storefront ? { storefront } : {})
      }
    }

    try {
      // 读取设置，检查是否有自定义插件市场 URL
      const settings = databaseAPI.dbGet('settings-general')
      const defaultBaseUrl = 'https://ztools.zosen.link'
      let baseUrl = defaultBaseUrl

      if (settings?.pluginMarketCustom && settings?.pluginMarketUrl) {
        baseUrl = settings.pluginMarketUrl.replace(/\/+$/, '') // 去除末尾斜杠
      }

      const pluginsJsonUrl = `${baseUrl}/plugins.json`
      const latestVersionUrl = `${baseUrl}/latest`
      const layoutUrl = `${baseUrl}/layout.yaml`
      const categoriesUrl = `${baseUrl}/categories.json`

      console.log('[Plugins] 从插件市场获取列表...', baseUrl)

      const timestamp = Date.now()

      let latestVersion = ''
      try {
        const versionResponse = await httpGet(`${latestVersionUrl}?t=${timestamp}`)
        latestVersion = versionResponse.data.trim()
        console.log(`发现最新插件列表版本: ${latestVersion}`)
      } catch (error) {
        console.warn('[Plugins] 获取版本号失败，将强制更新:', error)
      }

      const cachedVersion = databaseAPI.dbGet('plugin-market-version')
      if (cachedVersion === latestVersion && latestVersion) {
        const cachedResult = getCachedResult()
        if (cachedResult) {
          console.log('[Plugins] 使用本地缓存的插件市场列表')
          return cachedResult
        }
      }

      console.log('[Plugins] 下载新版本插件列表...')
      const response = await httpGet(`${pluginsJsonUrl}?t=${timestamp}`)
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
      const plugins = Array.isArray(json) ? json : []
      const pluginMarketFingerprint = this.getPluginMarketFingerprint(plugins)

      let storefront: PluginMarketStorefront | undefined
      try {
        const [layoutResponse, categoriesResponse] = await Promise.all([
          httpGet(`${layoutUrl}?t=${timestamp}`),
          httpGet(`${categoriesUrl}?t=${timestamp}`)
        ])

        const layoutRaw =
          typeof layoutResponse.data === 'string'
            ? layoutResponse.data
            : String(layoutResponse.data || '')
        const categories =
          typeof categoriesResponse.data === 'string'
            ? JSON.parse(categoriesResponse.data)
            : categoriesResponse.data || []

        storefront = this.buildPluginMarketStorefront(plugins, layoutRaw, categories)
      } catch (error) {
        console.warn('[Plugins] 获取或解析 storefront 数据失败，降级为平铺列表:', error)
      }

      databaseAPI.dbPut('plugin-market-version', latestVersion)
      databaseAPI.dbPut('plugin-market-data', plugins)
      if (storefront) {
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_CACHE_KEY, storefront)
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY, pluginMarketFingerprint)
      } else {
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_CACHE_KEY, null)
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY, null)
      }

      return { success: true, data: plugins, ...(storefront ? { storefront } : {}) }
    } catch (error: unknown) {
      console.error('[Plugins] 获取插件市场列表失败:', error)
      try {
        const cachedResult = getCachedResult()
        if (cachedResult) {
          console.log('[Plugins] 获取失败，降级使用本地缓存')
          return cachedResult
        }
      } catch {
        // ignore
      }
      return { success: false, error: error instanceof Error ? error.message : '获取失败' }
    }
  }

  /**
   * 生成插件列表的指纹字符串。
   * 用于判断缓存的 storefront 是否需要重新构建（插件名称/版本/平台变化时失效）。
   * @param plugins - 全量插件列表
   * @returns 排序后的指纹字符串
   */
  private getPluginMarketFingerprint(plugins: PluginMarketPlugin[]): string {
    return plugins
      .map(
        (plugin) =>
          `${plugin?.name || ''}:${plugin?.version || ''}:${JSON.stringify(plugin?.platform || [])}`
      )
      .sort()
      .join('|')
  }

  /**
   * 构建插件市场首页的 storefront 视图数据。
   * 将远程的 layout.yaml + categories.json + plugins.json 合并构建为渲染端可直接使用的结构。
   * 处理逻辑：
   * - 按当前平台过滤插件
   * - 解析 banner / navigation / fixed / random 四种区域类型
   * - fixed/random 区域中的插件自动去重（同一插件不会出现在多个区域）
   * @param plugins - 全量插件列表
   * @param layoutRaw - layout.yaml 的原始 YAML 内容
   * @param categoriesValue - categories.json 解析后的数据
   * @returns 构建好的 storefront 视图数据
   */
  private buildPluginMarketStorefront(
    plugins: PluginMarketPlugin[],
    layoutRaw: string,
    categoriesValue: unknown
  ): PluginMarketStorefront {
    const layoutParsed = yaml.parse(layoutRaw) as Record<string, unknown> | null
    const layoutSections = Array.isArray(layoutParsed?.layout)
      ? (layoutParsed!.layout as PluginMarketLayoutSectionConfig[])
      : []
    const categoriesList = Array.isArray(categoriesValue) ? categoriesValue : []

    // 按当前平台过滤插件
    const currentPlatform = process.platform
    const filteredPlugins = plugins.filter((plugin) => {
      if (!plugin?.platform || !Array.isArray(plugin.platform)) return true
      return plugin.platform.includes(currentPlatform)
    })

    const pluginMap = new Map<string, PluginMarketPlugin>()
    for (const plugin of filteredPlugins) {
      if (plugin?.name) {
        pluginMap.set(plugin.name, plugin)
      }
    }

    const categories: Record<string, PluginMarketStorefrontCategory> = {}
    for (const category of categoriesList as PluginMarketCategoryConfig[]) {
      if (!category?.key) {
        continue
      }
      const categoryPlugins = Array.isArray(category.list)
        ? category.list
            .map((pluginName) => pluginMap.get(pluginName))
            .filter((plugin): plugin is PluginMarketPlugin => !!plugin)
        : []

      categories[category.key] = {
        key: category.key,
        title: category.title || category.key,
        description: category.description,
        icon: category.icon,
        plugins: categoryPlugins
      }
    }

    // 解析 categoryLayouts：从 yaml 根级键提取 (default, 以及各 category key)
    const categoryLayouts: Record<string, PluginMarketCategoryLayoutSection[]> = {}
    if (layoutParsed) {
      for (const [key, value] of Object.entries(layoutParsed)) {
        if (key === 'layout') continue
        if (Array.isArray(value)) {
          categoryLayouts[key] = (value as PluginMarketCategoryLayoutSection[]).filter(
            (section) => section && typeof section.type === 'string'
          )
        }
      }
    }

    const usedPluginNames = new Set<string>()
    const sections: PluginMarketStorefrontSection[] = []
    let sectionIndex = 0

    const pushUniquePlugins = (pluginNames: string[]): PluginMarketPlugin[] => {
      const result: PluginMarketPlugin[] = []
      for (const pluginName of pluginNames) {
        const plugin = pluginMap.get(pluginName)
        if (!plugin || usedPluginNames.has(pluginName)) {
          continue
        }
        usedPluginNames.add(pluginName)
        result.push(plugin)
      }
      return result
    }

    for (const section of layoutSections) {
      const sectionKey = `${section.type || 'section'}-${sectionIndex++}`

      if (section.type === 'banner') {
        const items = Array.isArray(section.children)
          ? section.children.filter(
              (item): item is PluginMarketBannerItem =>
                typeof item?.image === 'string' && !!item.image
            )
          : []
        if (items.length > 0) {
          sections.push({
            type: 'banner',
            key: sectionKey,
            items,
            height: section.height
          })
        }
        continue
      }

      if (section.type === 'navigation') {
        const categoryKeys = Array.isArray(section.categories) ? section.categories : []
        const navCategories: Array<{
          key: string
          title: string
          description?: string
          icon?: string
          showDescription: boolean
          pluginCount: number
        }> = []

        for (const categoryKey of categoryKeys) {
          const category = categories[categoryKey]
          if (!category || category.plugins.length === 0) {
            continue
          }
          navCategories.push({
            key: category.key,
            title: category.title,
            description: category.description,
            icon: category.icon,
            showDescription: section.showDescription !== false,
            pluginCount: category.plugins.length
          })
        }

        if (navCategories.length > 0) {
          sections.push({
            type: 'navigation',
            key: sectionKey,
            title: section.title,
            categories: navCategories
          })
        }
        continue
      }

      if (section.type === 'fixed') {
        const pluginNames = Array.isArray(section.plugins) ? section.plugins : []
        const fixedPlugins = pushUniquePlugins(pluginNames)
        if (fixedPlugins.length > 0) {
          sections.push({
            type: 'fixed',
            key: sectionKey,
            title: section.title,
            plugins: fixedPlugins
          })
        }
        continue
      }

      if (section.type === 'random') {
        const count = typeof section.count === 'number' && section.count > 0 ? section.count : 0
        const availablePlugins = filteredPlugins.filter(
          (plugin) => plugin?.name && !usedPluginNames.has(plugin.name)
        )
        if (count > 0 && availablePlugins.length > 0) {
          const randomPlugins = shuffleArray(availablePlugins).slice(0, count)
          for (const plugin of randomPlugins) {
            usedPluginNames.add(plugin.name)
          }
          sections.push({
            type: 'random',
            key: sectionKey,
            title: section.title,
            plugins: randomPlugins
          })
        }
      }
    }
    return { sections, categories, categoryLayouts }
  }
}
