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
  ["Object.keys(i18nFile.editorPage.subConfig.nodeActions).map(type =>", "Object.keys(i18nFile.editorPage.subConfig.nodeActions).filter(type => useGlobalStore().env.backend !== 'CloudflareWorkers' || (!type.includes('Script') && type !== 'Response Transformer')).map(type =>"],
  ['<div v-if="actionTip" class="action-block-tip">', '<div v-if="useGlobalStore().env.backend === \'CloudflareWorkers\'" class="action-block-tip">此后端支持内置节点处理；不支持自定义 JavaScript 脚本或代理策略。</div>\n    <div v-if="actionTip" class="action-block-tip">'],
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
