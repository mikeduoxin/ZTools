<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useToast } from '@/components'
import { weightedSearch } from '@/utils'
import { WebSearchEditor } from './components'

const props = defineProps<{
  searchQuery?: string
}>()

const { success, error, confirm } = useToast()

interface WebSearchEngine {
  id: string
  name: string
  url: string
  icon: string
  enabled: boolean
  type: 'search' | 'webpage'
  keyword?: string
}

// 搜索引擎列表
const engines = ref<WebSearchEngine[]>([])
const isDeleting = ref(false)
const loading = ref(true)

const filteredEngines = computed(() =>
  weightedSearch(engines.value, props.searchQuery || '', [
    { value: (e) => e.name || '', weight: 10 },
    { value: (e) => e.url || '', weight: 5 }
  ])
)

// 编辑器状态
const showEditor = ref(false)
const editingEngine = ref<WebSearchEngine | null>(null)

// 加载列表
async function loadEngines(): Promise<void> {
  try {
    const result = await window.ztools.internal.webSearch.getAll()
    if (result.success && result.data) {
      engines.value = result.data
    }
  } catch (err) {
    console.error('加载搜索引擎列表失败:', err)
    error('加载搜索引擎列表失败')
  } finally {
    loading.value = false
  }
}

// 显示添加编辑器
function showAddEditor(): void {
  editingEngine.value = null
  showEditor.value = true
}

// 显示编辑编辑器
function handleEdit(engine: WebSearchEngine): void {
  editingEngine.value = engine
  showEditor.value = true
}

// 关闭编辑器
function closeEditor(): void {
  showEditor.value = false
  editingEngine.value = null
}

// 切换启用状态
async function handleToggleEnabled(engine: WebSearchEngine): Promise<void> {
  try {
    const updatedEngine = { ...engine, enabled: !engine.enabled }
    const result = await window.ztools.internal.webSearch.update(updatedEngine)
    if (result.success) {
      await loadEngines()
    } else {
      error(result.error || '更新失败')
    }
  } catch (err) {
    console.error('切换搜索引擎状态失败:', err)
    error('操作失败')
  }
}

// 保存
async function handleSave(engine: WebSearchEngine): Promise<void> {
  if (!engine.name || !engine.url) {
    error('请填写名称和 URL')
    return
  }
  if (engine.type === 'webpage' && !engine.keyword?.trim()) {
    error('请填写匹配关键字')
    return
  }

  try {
    const engineData = {
      id: engine.id,
      name: engine.name,
      url: engine.url,
      icon: engine.icon || '',
      enabled: engine.enabled !== undefined ? engine.enabled : true,
      type: engine.type || 'search',
      keyword: engine.keyword || ''
    }

    if (editingEngine.value) {
      const result = await window.ztools.internal.webSearch.update(engineData)
      if (result.success) {
        success('搜索引擎更新成功')
        await loadEngines()
        closeEditor()
      } else {
        error(result.error || '更新失败')
      }
    } else {
      const result = await window.ztools.internal.webSearch.add(engineData)
      if (result.success) {
        success('搜索引擎添加成功')
        await loadEngines()
        closeEditor()
      } else {
        error(result.error || '添加失败')
      }
    }
  } catch (err) {
    console.error('保存搜索引擎失败:', err)
    error('保存失败')
  }
}

// 删除
async function handleDelete(engineId: string): Promise<void> {
  const confirmed = await confirm({
    message: '确定要删除这个搜索引擎吗？',
    title: '删除确认',
    type: 'warning'
  })
  if (!confirmed) return

  isDeleting.value = true
  try {
    const result = await window.ztools.internal.webSearch.delete(engineId)
    if (result.success) {
      success('搜索引擎删除成功')
      await loadEngines()
    } else {
      error(result.error || '删除失败')
    }
  } catch (err) {
    console.error('删除搜索引擎失败:', err)
    error('删除失败')
  } finally {
    isDeleting.value = false
  }
}

onMounted(() => {
  loadEngines()
})
</script>
<template>
  <div class="content-panel">
    <!-- 可滚动内容区 -->
    <Transition name="list-slide">
      <div v-show="!showEditor" class="scrollable-content">
        <!-- 顶部添加按钮 -->
        <div class="panel-header">
          <button class="btn" @click="showAddEditor">添加网页快开</button>
        </div>

        <!-- 搜索引擎列表 -->
        <div class="engine-list">
          <div v-for="engine in filteredEngines" :key="engine.id" class="card engine-item">
            <div class="engine-info">
              <div class="engine-header">
                <img
                  v-if="engine.icon"
                  :src="engine.icon"
                  class="engine-icon"
                  alt=""
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                />
                <div v-else class="engine-icon-placeholder">
                  <div class="i-z-search font-size-16px"></div>
                </div>
                <h3 class="engine-name">{{ engine.name }}</h3>
              </div>
              <div class="engine-url">{{ engine.url }}</div>
              <div v-if="engine.type === 'webpage' && engine.keyword" class="engine-keyword">
                匹配关键字：{{ engine.keyword }}
              </div>
            </div>

            <div class="engine-actions">
              <span
                class="engine-type-badge"
                :class="{ 'engine-type-badge-webpage': engine.type === 'webpage' }"
              >
                {{ engine.type === 'webpage' ? '网页' : '搜索引擎' }}
              </span>
              <label class="toggle toggle-sm">
                <input
                  type="checkbox"
                  :checked="engine.enabled"
                  @change="handleToggleEnabled(engine)"
                />
                <span class="toggle-slider"></span>
              </label>
              <button
                class="icon-btn edit-btn"
                title="编辑"
                :disabled="isDeleting"
                @click="handleEdit(engine)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
              <button
                class="icon-btn delete-btn"
                title="删除"
                :disabled="isDeleting"
                @click="handleDelete(engine.id)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path
                    d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                  ></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- 空状态 -->
          <div v-if="!loading && engines.length === 0" class="empty-state">
            <div class="i-z-search empty-icon font-size-64px"></div>
            <div class="empty-text">暂无搜索引擎</div>
            <div class="empty-hint">点击"添加网页快开"来配置你的第一个网页快开</div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 编辑器覆盖面板 -->
    <Transition name="slide">
      <WebSearchEditor
        v-if="showEditor"
        :editing-engine="editingEngine"
        @back="closeEditor"
        @save="handleSave"
      />
    </Transition>
  </div>
</template>

<style scoped>
.content-panel {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-color);
}

/* 可滚动内容区 */
.scrollable-content {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px;
}

/* 列表滑动动画 */
.list-slide-enter-active {
  transition:
    transform 0.2s ease-out,
    opacity 0.15s ease;
}

.list-slide-leave-active {
  transition:
    transform 0.2s ease-in,
    opacity 0.15s ease;
}

.list-slide-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}

.list-slide-enter-to {
  transform: translateX(0);
  opacity: 1;
}

.list-slide-leave-from {
  transform: translateX(0);
  opacity: 1;
}

.list-slide-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

/* 顶部按钮 */
.panel-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 20px;
}

.engine-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.engine-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  transition: all 0.2s;
}

.engine-item:hover {
  border-color: var(--primary-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.engine-info {
  flex: 1;
  min-width: 0;
}

.engine-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.engine-icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  object-fit: contain;
  flex-shrink: 0;
}

.engine-icon-placeholder {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.engine-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-color);
  margin: 0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toggle-sm {
  display: flex;
  align-items: center;
  width: 36px;
  height: 20px;
  margin: 0 7px;
}

.toggle-sm .toggle-slider {
  border-radius: 20px;
}

.toggle-sm .toggle-slider::before {
  width: 12px;
  height: 12px;
}

.toggle-sm input:checked + .toggle-slider::before {
  transform: translateX(16px);
}

.toggle-sm input:checked + .toggle-slider:hover::before {
  transform: translateX(16px) scale(1.15);
}

.engine-url {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.4;
}

.engine-type-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 22px;
  padding: 0 6px;
  margin-right: 8px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1;
  color: var(--primary-color);
  background: var(--primary-light-bg);
}

.engine-type-badge-webpage {
  color: #d97706;
  background: rgba(245, 158, 11, 0.14);
}

:global([data-theme='dark']) .engine-type-badge-webpage {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.16);
}

.engine-keyword {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.engine-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-left: 16px;
  flex-shrink: 0;
}

.engine-actions .icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
}

/* 图标按钮颜色样式 */
.edit-btn {
  color: var(--primary-color);
}

.edit-btn:hover:not(:disabled) {
  background: var(--primary-light-bg);
}

.delete-btn {
  color: var(--danger-color);
}

.delete-btn:hover:not(:disabled) {
  background: var(--danger-light-bg);
}

.empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  pointer-events: none;
}

.empty-icon {
  color: var(--text-secondary);
  opacity: 0.3;
  margin-bottom: 16px;
}

.empty-text {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-color);
  margin-bottom: 8px;
}

.empty-hint {
  font-size: 14px;
  color: var(--text-secondary);
}
</style>
