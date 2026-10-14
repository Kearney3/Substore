import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/patch-workers-frontend.mjs <frontend checkout>');
function patch(path, replacements) {
  const file = resolve(root, path);
  let text = readFileSync(file, 'utf8');
  for (const [before, after] of replacements) {
    if (!text.includes(before)) throw new Error(`Official frontend changed: ${path}; review the Workers patch`);
    text = text.replace(before, after);
  }
  writeFileSync(file, text);
}
patch('src/views/editor/ActionBlock.vue', [
  ["import i18nFile from '@/locales/zh';", "import i18nFile from '@/locales/zh';\nimport { useGlobalStore } from '@/store/global';"],
  ["Object.keys(i18nFile.editorPage.subConfig.nodeActions).map(type =>", "Object.keys(i18nFile.editorPage.subConfig.nodeActions).filter(type => { const feature = useGlobalStore().env.feature; if (!feature?.workers) return true; if (type === 'Response Transformer') return feature.responseScripts === true; if (type.includes('Script')) return (sourceType === 'file' ? feature.fileScripts : feature.nodeScripts) === true; return true; }).map(type =>"],
  ['<div v-if="actionTip" class="action-block-tip">', '<div v-if="useGlobalStore().env.feature?.workers" class="action-block-tip">{{ useGlobalStore().env.feature?.scripts ? \'支持受限脚本；不支持 Node 模块、本地文件或代理策略。脚本大小和运行时间有限制。\' : \'此后端暂不支持自定义脚本。\' }}</div>\n    <div v-if="actionTip" class="action-block-tip">'],
]);
patch('src/views/SyncEditor.vue', [
  ['env.value.backend !== "Node"', 'env.value.backend !== "Node" && !env.value?.feature?.artifactCron'],
]);
const syncEditorPath = resolve(root, 'src/views/SyncEditor.vue');
let syncEditor = readFileSync(syncEditorPath, 'utf8');
const cronInputEnd = 'v-model.trim="form.cron"';
if (!syncEditor.includes(cronInputEnd)) throw new Error('Review official cron editor');
// Put the platform constraint next to the native cron editor, preserving its form and validation.
syncEditor = syncEditor.replace('class="cron-wrapper" prop="cron">', 'class="cron-wrapper" prop="cron">\n          <p v-if="env?.feature?.artifactCron">定时任务时区：{{ env?.meta?.workers?.cronTimezone }}；最短间隔 5 分钟。</p>');
writeFileSync(syncEditorPath, syncEditor);
patch('src/views/Sync.vue', [
  ['import { ref, computed, toRaw, onMounted, watch } from "vue";', 'import { ref, computed, toRaw, onMounted, watch } from "vue";\nimport workersRequest from "@/api";'],
  ['<div class="subs-list-wrapper"', `<details v-if="env?.feature?.artifactCron" style="margin: 12px" @toggle="loadWorkersTasks">
      <summary>后台任务状态</summary>
      <p v-if="workersTasksError">{{ workersTasksError }}</p>
      <p v-for="task in workersTasks" :key="task.name">{{ task.name }} · {{ task.status }} · {{ task.error || new Date(task.next_run).toLocaleString() }}</p>
      <p v-for="notice in workersNotifications" :key="notice.id">通知 · {{ notice.status }} · {{ notice.error }}</p>
      <p v-if="!workersTasks.length && !workersTasksError">暂无定时任务</p>
    </details>\n    <div class="subs-list-wrapper"`],
  ['const isNodeBackend = computed(', `const workersTasks = ref<any[]>([]);
const workersNotifications = ref<any[]>([]);
const workersTasksError = ref("");
const loadWorkersTasks = async (event: Event) => {
  if (!(event.target as HTMLDetailsElement).open) return;
  try {
    const response = await workersRequest({ url: "/api/workers/tasks", method: "get" });
    workersTasks.value = response?.data?.data?.tasks || [];
    workersNotifications.value = response?.data?.data?.notifications || [];
    workersTasksError.value = "";
  } catch { workersTasksError.value = "无法读取后台任务状态"; }
};
const isNodeBackend = computed(`],
]);
patch('src/views/settings/AboutUs.vue', [
  ['</template>', '<p style="text-align:center"><a href="https://github.com/Kearney3/Substore" target="_blank" rel="noopener noreferrer">Cloudflare 部署版源码 · AGPL-3.0</a></p>\n</template>'],
]);
patch('src/types/store/globalStore.d.ts', [["| 'Node';", "| 'Node' | 'CloudflareWorkers';"]]);
// The native backend-path dialog must also appear on direct management-page visits.
const appPath = resolve(root, 'src/App.vue');
const appSource = readFileSync(appPath, 'utf8');
if (!appSource.includes("route.path === '/subs'")) throw new Error('Review official access dialog changes');
writeFileSync(appPath, appSource.replaceAll("route.path === '/subs'", "route.path !== '/404'"));
for (const path of ['src/views/share/ShareEditorPage.vue', 'src/components/ShareListItem.vue']) {
  patch(path, [['env.value?.meta?.node?.env?.SUB_STORE_FRONTEND_BACKEND_PATH || ""', 'env.value?.meta?.workers?.secretPath || env.value?.meta?.node?.env?.SUB_STORE_FRONTEND_BACKEND_PATH || ""']]);
}
console.log('Applied Workers capability and source notices to the official frontend.');
