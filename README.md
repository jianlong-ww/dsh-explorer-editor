# dsh-explorer-editor

**在 DSH 的文件预览面板里直接编辑**：用 Monaco（VS Code 的编辑器）打开工作区文本文件，带语法高亮和基于工程类型的补全。

版本 `0.1.0`。编译产物（`lib/`，含 Monaco 构建）随仓库提供，克隆后可直接安装，无需构建。

## 功能

打开右侧栏里的文本文件，**预览面板本身就是编辑器**，不再是只读文本：

- Monaco 渲染：语法高亮、行号、多光标、撤销栈、括号匹配、查找替换；
- 补全来自 Monaco 的 TypeScript worker，且**带工程类型**——Host 读取项目的 `tsconfig.json`，把该文件 `import` 到的库的 `.d.ts` 闭包一起送进 worker，因此 React 的组件 props、hook 签名、CSS 属性都能补出来；
- `Ctrl/Cmd+S` 或顶栏「保存」写回磁盘，走版本 CAS：文件在编辑期间被改动时，保存不会静默覆盖，而是给出「重新载入 / 覆盖保存」；
- 只读会话保存会被拒绝并说明原因；
- 顶栏显示路径与未保存状态，并提供「从磁盘重新载入」；
- 超出大小上限、非 UTF-8、二进制文件会被拒绝，而不是打开乱码。

## 支持的文件类型

| 类别 | 后缀 |
|---|---|
| 代码 | `ts tsx mts cts js jsx mjs cjs py go rs java kt kts rb php cs swift c h cpp cc cxx hpp hh m mm` |
| 标记与数据 | `json jsonc json5 css scss less html htm xml vue svelte graphql gql` |
| 文档 | `md markdown mdx txt text rst adoc` |
| 配置与脚本 | `yml yaml toml ini conf cfg env properties sh bash zsh fish ps1 psm1 bat cmd gradle sql lock log` |
| 点文件 | `gitignore gitattributes gitmodules npmrc nvmrc yarnrc editorconfig prettierrc eslintrc babelrc dockerignore clang-format tool-versions` 等（按点后面的名字匹配，例如 `.gitignore` 的后缀是 `gitignore`） |

DSH 的匹配规则是「文件名以 `.` + 后缀结尾」，因此**没有后缀的文件**（`Makefile`、`LICENSE`）和未列出的后缀仍由内置只读视图打开。图片、PDF、Office 文档不会被接管；Markdown 默认进编辑器，但内置的渲染视图仍在视图菜单里可切回。

## 要求

- DSH `0.2.1-rc.5` 或更新（在 `0.2.1-rc.5` 与 `0.2.2-alpha.2` 上验证）；
- 安装时需要能访问插件所在目录；运行本身不需要网络。

## 安装

```sh
dsh plugin --profile desktop add @jianlong-ww/dsh-explorer-editor
dsh --profile desktop --dump-config     # 确认出现 explorer-editor 这一层
```

装完**重启 dsh**（Host 半在启动时加载），然后刷新页面。

卸载：

```sh
dsh plugin --profile desktop remove @jianlong-ww/dsh-explorer-editor
```

### 从源码安装（开发用）

```sh
git clone https://github.com/jianlong-ww/dsh-explorer-editor.git
cd dsh-explorer-editor
pnpm install && pnpm build     # 产出 lib/，并把 Monaco 构建拷进 lib/monaco
dsh plugin --profile desktop add .
```

`add` 对本地目录建立链接安装，之后改代码只需 `pnpm build` 并重启 dsh。

> 不要用 `dsh plugin add git+https://…`：pnpm 会把 git 依赖当成待构建的包去安装它的 devDependencies（含 `monaco-editor`），在 Windows 上还会因跨盘符号链接而报 `EPERM`。registry 包或本地目录都不会触发这个问题。

## 配置

在 profile 的 patch 里按 `id: explorer-editor` 覆盖（整段替换，不是深合并）：

```yaml
- insert:
    - id: explorer-editor
      name: '@jianlong-ww/dsh-explorer-editor'
      config:
        maxWriteBytes: 2097152    # 单次保存的文本上限（UTF-8 字节）
        respectSessionMode: true  # 是否沿用会话的沙箱模式
```

缺省值分别是 2 MiB 与 `true`；非法值回落到缺省。

## 工作原理

1. **接管预览正文**：DSH 的文件预览是「渲染器注册表 + keyed 正文槽」。插件注册一个按后缀匹配的实现（外部实现排在内置之前），面板据此选中唯一的正文组件，因此内置只读正文不会被渲染——是替换，不是覆盖。
2. **正文自己加载内容**：正文以 `loading: 'renderer'` 模式读取文件并回报版本；读走宿主已有的只读 Remote（`workspaceFiles.readBytes`）。
3. **保存走 Host**：`POST /explorer-editor/api/save`，在 Host 侧完成沙箱模式、工作区包含性、符号链接、大小上限与版本 CAS 的校验，成功后发出 `fs/observed` 让预览刷新。
4. **类型来自 Host**：`GET /explorer-editor/api/types` 返回 `tsconfig` 的 `compilerOptions`（支持 `extends` 与项目引用）与该文件 import 的声明闭包，交给 Monaco 的 TS worker。
5. **Monaco 由 Host 提供**：编辑器构建（含四个 worker）经 `/explorer-editor/monaco/*` 按需提供，带 gzip、ETag 与路径穿越防护，并在首次打开时由 `client.js` 动态加载。

## 体积与加载

| 组成 | 体积 |
|---|---|
| `lib/index.js`（Host） | 36 KB，无第三方运行时依赖 |
| `lib/client.js`（浏览器半） | 39 KB |
| `lib/monaco/vs/**` | 14.6 MB（121 文件），经 Host 路由提供 |
| 首次打开编辑时的传输 | 约 2.5–3 MB（gzip），之后走浏览器缓存 |

Monaco 不打包进 `client.js`：模块表会为每个会话加载该文件，把编辑器塞进去没有意义。

## 已知限制

- **补全限于单文件**：工程上下文是「当前文件 + 它 import 的库类型」，其它源文件没有作为 model 送进 worker，所以没有跨文件跳转与诊断；
- **不做语义诊断**：worker 只看得到声明，看不到整个工程，语义报错会是噪音，因此只保留语法校验；补全与 hover 不受影响；
- **首次打开有一次性成本**：约 2.5–3 MB 下载 + worker 启动 + 类型注入；
- 未保存的修改在刷新页面后会丢失；
- 冷会话（无 live Session）时沙箱模式退化为部署默认值。

## 排障

```powershell
# Host 半是否加载
curl http://127.0.0.1:<port>/explorer-editor/api/state -H "x-explorer-editor-request: 1"

# 类型端点是否为某个真实文件解析出声明
curl "http://127.0.0.1:<port>/explorer-editor/api/types?path=D%3A%2Ftest%2Fsrc%2FApp.tsx&sessionId=<id>" -H "x-explorer-editor-request: 1"

# Monaco 资源是否可取
curl -I http://127.0.0.1:<port>/explorer-editor/monaco/vs/editor/editor.main.js
```

浏览器 DevTools 里应能看到 `plugins/??dsh-explorer-editor/client.js` 与 `explorer-editor/monaco/vs/**` 两组请求；编辑器没出现时先看 Console 是否有缺服务（如 `documentPreviews`）的报错。

## 开发

```sh
pnpm install          # 需要能访问 npm：monaco-editor 在 devDependencies 里
pnpm build            # tsdown + 把 Monaco 的 min/vs 剪枝拷贝进 lib/monaco
pnpm test             # 59 个用例
pnpm typecheck        # 见下
pnpm check            # 三者串起来
```

- 构建会重写 `lib/`（包括 Monaco 的哈希文件名），提交前请确认差异；
- 若 `pnpm build` 找不到 `monaco-editor`，用 `node scripts/sync-monaco.mjs --from <monaco-editor 目录>` 或设置 `MONACO_DIR`；
- `pnpm typecheck` 需要本机有一份 DSH 源码 checkout（默认 `../deepseek-harness`，`--harness` 可指定）：外部项目拿不到 `@deepseek-ai/*` 的构建产物，脚本会从该 checkout 生成本地类型别名，并只把本仓库的诊断当作失败。

## 仓库结构

```
src/index.ts           Host 半：保存端点、类型端点、Monaco 静态路由
src/client/            浏览器半：预览正文、Monaco 加载、保存与冲突
src/protocol.ts        两端共享的线格式
scripts/               构建与校验脚本（Monaco 拷贝、类型别名、typecheck 门禁）
tests/                 vitest 用例
locale/                插件显示元数据
lib/                   编译产物（已入库，可直接安装）
```

## License

MIT，见 [LICENSE](LICENSE)。内置的 Monaco 构建来自 `monaco-editor`（MIT）。
