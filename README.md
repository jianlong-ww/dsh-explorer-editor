# dsh-explorer-editor

在 DSH 的**文件预览面板里直接编辑**，用 Monaco（VS Code 的编辑器），带语法高亮和基于工程类型的补全。

状态：**V1 可用**。产物在 `lib/`，随插件一起发布，装上即可用。

## 现在能做什么

打开右侧栏里的 `.ts` / `.tsx` / `.js` / `.jsx` / `.json` / `.css` / `.scss` / `.less` / `.html` 文件——**预览面板本身就是编辑器**，不再是只读文本：

- Monaco 渲染，语法高亮、行号、多光标、撤销栈、括号匹配、查找替换都是编辑器原生行为；
- 补全来自 Monaco 的 TypeScript worker，并且**带工程类型**：Host 会读取项目的 `tsconfig.json`，把该文件 `import` 到的库的 `.d.ts` 闭包一起送进 worker，所以 React 的组件 props、hook 签名、CSS 属性都能补出来；
- `Ctrl/Cmd+S` 或工具栏「保存」写回磁盘，走版本 CAS：文件在编辑期间被改动，保存不会静默覆盖，给出「重新载入 / 覆盖保存」；
- 只读会话保存会被拒并说明原因；
- 顶栏有路径、未保存标记、重新载入；文件超上限、非 UTF-8、二进制会被拒绝而不是打开乱码。

Markdown 仍由内置渲染器显示（它渲染标题/链接/图片，比纯文本编辑器有用），图片、PDF、Office 一律不碰。

## 安装

仓库只包含源码：`lib/`（含 14.6 MB 的 Monaco 构建）是产物，不入库，克隆后需要先构建。

```sh
pnpm install          # 需要能访问 npm：monaco-editor 在 devDependencies 里
pnpm build            # 产出 lib/index.js、lib/client.js，并把 Monaco 的 min/vs 拷进 lib/monaco
dsh plugin --profile desktop add .
dsh --profile desktop --dump-config     # 确认出现 explorer-editor 这一层
```

装进 profile 后**刷新页面**即可；Host 侧的改动需要重启 dsh。链接安装，改完 `pnpm build` 再刷新，不用重新 add。

建议先装进专用 profile（如 `explorer-dev`）：装进去即对该 profile 的所有会话开放写入口。

> 如果 `pnpm build` 找不到 `monaco-editor`，用 `--from` 或环境变量指向一份已解包的同版本构建：
> `node scripts/sync-monaco.mjs --from <monaco-editor 目录>` / `MONACO_DIR=<目录> pnpm build`。

## 产物构成

| 文件 | 体积 | 作用 |
|---|---|---|
| `lib/index.js` + `.d.ts` | 34 KB | Host：保存端点、部署事实、类型端点、Monaco 静态资源路由 |
| `lib/client.js` | 36 KB | 浏览器半：注册预览正文、按需加载 Monaco、保存与冲突 |
| `lib/monaco/vs/**` | 14.6 MB（121 文件） | Monaco 的浏览器构建，经 Host 路由按需提供 |
| 首次打开编辑时的传输 | **约 2.5–3 MB（gzip）** | 入口 + 编辑器 chunk + ts.worker（+ css/html/json worker），之后走浏览器缓存 |

Monaco 不打包进 `client.js`：模块表为每个会话都会加载 `client.js`，把 15 MB 塞进去没有意义。它在**第一次打开编辑器文件时**才由 `client.js` 注入 `vs/loader.js` 并从 Host 拉取。

## 工作原理

1. **接管预览正文**。DSH 的预览是「注册表 + keyed 槽」：`ctx.documentPreviews.register({ id, extensions, priority: 'extension' })` 决定某后缀用哪个实现（外部实现排在内置之前），`sidebar.right.tab.document` 这个 keyed 槽只挂载被选中的那一个。所以内置只读正文**不会被渲染**——不是覆盖，是替换。
2. **正文自己加载内容**。`loading: 'renderer'` 让正文自己读文件并回报版本；读的是宿主已有的只读 Remote（`workspaceFiles.readBytes`），保存打的是本插件的 Host 端点，沙箱、工作区包含性、版本 CAS 全在 Host 侧，与上一版完全一致。
3. **类型来自 Host**。`GET /explorer-editor/api/types?path=…&sessionId=…` 返回 `{ options, libraries[] }`：最近的 `tsconfig.json`（含 `extends` / 项目引用）里的 `compilerOptions`，加上该文件 import 的声明闭包（含 `@types/*` 回退、pnpm 的 `.pnpm/node_modules` 隐藏提升、递归深度 3、体积上限）。
4. **Monaco 由 Host 提供**。DSH 的插件资源路由只放行图片，所以 Monaco 由我们自己的 `webServer` 路由 `/explorer-editor/monaco/*` 提供，带 gzip、ETag 和路径穿越防护；`vs/editor/editor.main.js` 是 AMD 入口，它会自己装好 worker 环境（blob + `importScripts`），worker URL 也指向同一条路由。

## 开发

```sh
pnpm install          # 需要能访问 npm（monaco-editor 在 devDependencies 里）
pnpm build            # tsdown + 把 monaco 的 min/vs 剪枝拷贝进 lib/monaco
pnpm test             # 57 个用例
pnpm typecheck        # 见下
pnpm check            # 三者串起来
```

- `pnpm build` 需要一份 `monaco-editor`。若它不在本仓库 `node_modules` 里，可以给 `scripts/sync-monaco.mjs` 传 `--from <monaco-editor 目录>` 或设环境变量 `MONACO_DIR`。
- `pnpm typecheck` 需要本机有一份 harness 源码 checkout（默认 `../deepseek-harness`，`--harness` 可指定）：外部仓库拿不到 `@deepseek-ai/*` 的构建产物，所以脚本从 harness 的 tsconfig 生成源码级别名到 `tsconfig.local.json`，再由 `scripts/typecheck.mjs` 只把**本仓库**的诊断当作失败。

## 已知限制（V1 边界）

- **补全只在单文件范围内**：工程上下文是「该文件 + 它 import 的库类型」，其它源文件没有作为 model 送进 worker，所以没有跨文件跳转与诊断。要做真 IDE，下一步是在 Host 上跑 tsserver + LSP 桥。
- **不做语义诊断**：worker 只看得到声明，看不到整个工程，语义报错会是噪音，所以 `noSemanticValidation` 打开、语法校验保留。补全与 hover 不受影响。
- **首次打开有一次性成本**：约 2.5–3 MB 下载 + worker 启动 + 类型注入（本机实测类型解析约 40 ms，注入与编译在 worker 里）。
- 未保存的修改在刷新页面后会丢失；V1 没有本地持久化。
- 冷会话（无 live Session）时沙箱模式退化为部署默认值。

## 排障

```powershell
# Host 是否活着
curl http://127.0.0.1:<port>/explorer-editor/api/state -H "x-explorer-editor-request: 1"

# 类型端点是否为某个真实文件解析出声明
curl "http://127.0.0.1:<port>/explorer-editor/api/types?path=D%3A%2Ftest%2Fsrc%2FApp.tsx&sessionId=<id>" -H "x-explorer-editor-request: 1"

# Monaco 资源是否在
curl -I http://127.0.0.1:<port>/explorer-editor/monaco/vs/editor/editor.main.js
```

浏览器侧：DevTools 里应能看到 `plugins/??dsh-explorer-editor/client.js` 和 `explorer-editor/monaco/vs/**` 两组请求；编辑器没出现时先看 Console 有没有缺服务（如 `documentPreviews`）的报错。

## 仓库约定

仓库只跟插件本身：`src/`（源码）、`tests/`、`scripts/`、`locale/`、`package.json` 与三份构建配置，产物在 `lib/`（已忽略）。

设计笔记、调研和一次性探针都放在 `tmp/`（已忽略，不入库）——包括 DSH 文件预览的架构参考（`tmp/docs/003`、`004`）、本插件的历史方案（`000`、`002`）与已废弃的弹窗版产品说明（`001`）。需要时本地查看即可。

## License

MIT，见 [LICENSE](LICENSE)。内置的 Monaco 构建来自 `monaco-editor`（MIT）。
