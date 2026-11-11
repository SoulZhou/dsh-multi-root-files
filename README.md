# dsh-multi-root-files

右侧栏的多根文件树：同时列出**会话主目录**与 multi-root-workspace 登记的**每个附加工作区根**，
点击文件直接在右侧侧栏的编辑器标签里打开（不新开窗口、不调用外部程序）。

DSH 自带的「文件」面板只从会话主目录向下扫描，附加根里的代码在面板里根本看不见。
这个插件补上那一层：根列表由宿主侧路由从多根登记表读出，目录内容仍走 better-sidebar
现成的 `fs.trees` 路由（工作区围栏已移除，绝对路径在 cwd 之外也能列）。

![多根文件树](screenshots/panel.png)

## 它解决什么问题

很多项目的实际结构是**若干个平级仓库**：

```text
D:\dev\demo-platform\
  web-console\      ← 会话主目录
  api-gateway\      ← 同级，附加工作区根
  shared-i18n\      ← 同级，附加工作区根
```

`api-gateway`、`shared-i18n` 都不在 `web-console` 下面，所以自带面板永远扫描不到它们 ——
哪怕你已经用 `@dsh-electron/dsh-plugin-multi-root-workspace` 把它们登记成了附加根，
Agent 能读写它们，**但你仍然只能在面板里看到主目录的文件**。

本插件把根列表换成「主目录 + 全部附加根」，一个页签里切换查看。

## 功能

- **根列表**：工具栏的下拉框列出全部根——主目录排第一（标记「主目录」），附加根按登记顺序
  跟上（标记「附加」）。选中哪个根，树就显示哪个根。
- **目录懒加载**：展开目录时按批请求 `fs.trees`（每次 ≤64 个路径），单层失败只在该层显示
  「这个目录读取失败」，不会让整个面板报错。
- **左右分栏**：点文件时，树在左、文件内容在右并排显示（不是上下堆叠），
  这样在侧栏这种窄列里文件树仍然可读。

  ![内联预览](screenshots/preview.png)

- **附加根一样能用**：切到附加根，目录树照常展开——附加根的代码不用切窗口就能看。

  ![附加根](screenshots/additional-root.png)

- **Git 状态标记**：已修改 / 未跟踪 / 忽略的文件在树里带标记，目录本身也会标出「里面改了东西」。
- **降级**：附加根登记表缺失时给出提示但仍显示主目录；根不存在（`exists:false`）时该节
  显示「目录不存在或不可访问」；刷新按钮重新读取根列表与当前展开层。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主侧：注册 `POST /dsh-multi-root-files/api/roots`，返回主目录 + 附加根（含 `exists`）|
| `client.js` | 浏览器侧：通过 `ctx.get('betterSidebar').registerTab` 注册「多根文件」标签 |
| `cordis.patch.yml` | bundle patch，插入插件自身一行 |

宿主侧另有三个只读路由：`/status`（Git 状态标记）、`/image`（图片预览）、`/diff`（改动行号）。

## 访问级别与安全

**只读**。这个插件从不写入、重命名或删除任何文件：

- 目录列表走 better-sidebar 现成的 `fs.trees` 路由，宿主侧不直接读盘。
- 打开文件是侧栏编辑器自己的职责（仍在右侧栏内）。
- `/status` 只跑 `git status` 与 `git check-ignore`；`/diff` 只跑 `git diff --unified=0`。
- `/image` 只读一个图片文件的字节，超过 12 MiB 直接拒绝。

## 依赖

- `dsh-better-sidebar`（服务名 `betterSidebar`，需要 `registerTab` / `openFile` / `hostRouteUrl`）
- 可选：`@dsh-electron/dsh-plugin-multi-root-workspace`（提供附加根登记；不装也能用，只是
  只剩主目录）

## 安装

```sh
dsh plugin --profile desktop add /path/to/dsh-multi-root-files
```

或用 npm 包名 / 本地目录在**插件 → 添加插件**里安装。

装完 **完全退出并重新打开 DeepSeek Harness**（只刷新页面不够：宿主半的路由需要重新加载）。

## 用法

右侧栏点 `+` → **多根文件**（或在页签条里切到它）。

- 顶部下拉框切换根（`web-console · 主目录` / `api-gateway · 附加` / …）。
- 点文件夹展开，点文件在右侧预览。
- 右上角 `↻` 重新读取根列表与当前展开层。

## 开发与验证

```sh
node --check index.js
node --check client.js
```

## 许可证

MIT
