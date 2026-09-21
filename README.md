# 绘画练习图库 · Drawing Practice Gallery

把日常绘画练习的成品图和 PSD 工程文件放进 `works/日期/` 目录，推送到 GitHub，
自动部署成一个在线图库：**按日期分组浏览、在网页里把 PSD 当 PNG 查看、点图层名
隐藏/显示单个图层、下载原始 PSD**。

## 它是怎么工作的

`works/` 下每个 PSD 在**构建时**被处理一次：生成 480px 缩略图、1600px 预览图、
图层树元数据，并写入 `public/generated/manifest.json`；源 PSD 同时复制进产物，
供下载。浏览器端则是**纯静态**的，只在你要看某个作品的图层时才去解析那个 PSD。

为什么这么设计，本机实测数据说了算（Chromium 152 headless，详见 `DECISIONS.md`）：

| 操作 | 实测耗时 |
|---|---|
| 只读目录结构 / 图层名 | 0.1–2.8 ms（几乎免费） |
| 完整解码（合成图 + 全部图层） | **4–7 MP/s**：1.9 MP → 318 ms；8.7 MP → 1.3–2.0 s |
| 合成图编码成 PNG | 0.4–0.5 s（A4 @300dpi） |
| 已解码图层重绘到 1500px 画布 | 数十 ms |

结论直接决定了三条产品约束：

1. **列表页绝不解析 PSD** —— 用构建时缩略图，所以秒开；
2. **解码只在 Web Worker 里** —— 解码是同步的且只有 4–7 MP/s，放主线程必卡死；
3. **切图层只重绘、不重新解码** —— 每层位图解码一次后缓存，点眼睛图标只重绘。

## 目录约定

```
works/
├── 2026-09-21/
│   ├── 1.psd          ← 文件名按数字排序
│   └── 2.psd
└── 2026-09-24/
    └── 1.psd
```

- 文件夹名必须是 `YYYY-MM-DD`（其他名字会被忽略并给出提示）；
- 文件名建议用数字，站点按数字大小排序（`2.psd` 排在 `10.psd` 前面）；
- 支持任意层级：日期目录下的 `*.psd` 都会被收录。

## 本地使用

```bash
npm install
npm run samples     # 可选：生成 3 个示例 PSD，先看效果
npm run dev         # 生成 manifest 并启动开发服务器 http://127.0.0.1:5173
```

> **关于示例 PSD**：用 ag-psd 写图层、再自己补上合成图。原因是两个库各缺一半
> ——ag-psd 的写入器不会拍平图层（合成区全黑，实测 avg=0），而 psd-tools 写的
> RGBA 图层会被 ag-psd 读成全不透明（透明区变黑）。细节见
> `scripts/samples/psd-write.ts`。你自己的作品不需要这一步，Photoshop 导出的
> 文件两样都是对的。

常用命令：

| 命令 | 作用 |
|---|---|
| `npm run manifest` | 只重新扫描 `works/` 并生成产物（加了新图后先跑它） |
| `npm run dev` | 生成 manifest + 启动开发服务器 |
| `npm run build` | 生成 manifest + 类型检查 + 构建到 `dist/` |
| `npm run preview` | 本地预览构建产物 |
| `npm run test:unit` | 单元测试（图层合成决策、代理缩放、混合模式回退、manifest/索引解析） |
| `npm test:e2e` | 用真实 headless Chrome 跑端到端验收（需先 `npm run build`） |
| `npm run verify:proxy` | 生成一张 8.3 MP 的临时 PSD，验证代理缩放路径后自动清理 |
| `npm run verify:scale` | 用合成 manifest 验证「日期很多」时首屏仍然有界（分页生效） |
| `npm run verify:workflows` | 校验 CI 触发规则：分支 push 不构建、版本 tag 才构建 |
| `npm run bench:scale` | 生成 N 个临时 PSD，实测构建耗时 / 产物体积 / DOM 规模随作品数增长 |
| `npm run typecheck` | 全项目类型检查 |

> **注意**：`public/generated/` 是构建产物，已在 `.gitignore` 中，不要提交。

## 部署到 GitHub Pages

1. **安装 Git LFS（必须）**。GitHub 拒绝任何超过 100 MiB 的单个文件，
   带图层的 PSD 很容易超；仓库里的 `.gitattributes` 已把 `*.psd` 指向 LFS：

   ```bash
   git lfs install
   git add .gitattributes
   git add works/2026-09-21/1.psd     # 会走 LFS，而不是普通对象
   git commit -m "add works"
   git push
   ```

   > ⚠️ **本次生成的仓库需要先做一次转换**：构建环境里没有安装 git-lfs，
   > 所以初始提交里的 3 个示例 PSD 目前是**普通 Git 对象**（约为 11 MiB，能正常 push，
   > 只是因为 `.gitattributes` 已声明规则）。在你自己的机器上执行一次即可把历史里的
   > PSD 全部转成 LFS 对象：
   >
   > ```bash
   > git lfs install
   > git lfs migrate import --include="*.psd" --everything
   > git push --force-with-lease        # 仅当远程还没有别人拉取过时
   > ```
   >
   > 之后再新增的 PSD 会自动走 LFS，不需要再迁移。

2. **只有打 tag 才会构建部署**。`git push` 代码（无论 push 到 `main` 还是别的分支）
   **不会**触发构建；发布一个新版本靠打 tag：

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

   工作机制：`.github/workflows/deploy.yml` 的触发条件里**故意不写 `branches`**，
   只写 `tags: ['v*']`。GitHub Actions 的分支过滤与标签过滤是**互相独立**的，
   分支引用不可能匹配标签模式，所以普通 push 一定不会构建，只有 `v` 开头的
   tag 才会。

   需要从分支直接部署、或临时重新部署某个提交时，用 **workflow_dispatch**
   （Actions 页面 → 「Run workflow」）手动触发，不需要打 tag。

   两点容易踩的细节：

   - **tag 必须是 `v` 开头**（`tags: ['v*']`）：`v1.0.0`、`v2`、`v1.2.3-beta` 都会
     构建；`release-1`、`1.0.0` 不会。想放宽就改 `tags` 里的模式。
   - **`git push --follow-tags` 会部署**：它同时推分支和 tag，触发的是 tag 那一侧，
     不是分支。不想要部署就别带 `--follow-tags` / `--tags`。

   触发规则本身有自动化校验（`npm run verify:workflows`）：它解析真实的工作流
   YAML，按 GitHub 的 push 过滤规则断言「分支 push 不触发、版本 tag 触发」，
   以后有人误加 `branches:` 或删掉 `tags:` 会直接测试失败。

3. **在仓库设置里开启 Pages**：Settings → Pages → Source 选择 **GitHub Actions**。

4. **访问地址**：`https://<用户名>.github.io/<仓库名>/`。
   工作流会自动把 `BASE_PATH` 设成 `/<仓库名>/`，这是子路径部署能正确加载
   资源的关键；如果你用的是 `<用户名>.github.io` 这种根域名仓库，
   把仓库变量 `BASE_PATH` 设为 `/` 即可。本地想验证子路径部署：

   ```bash
   BASE_PATH=/你的仓库名/ npm run build && npm run preview
   ```

## 新增作品的两种方式

- **方式 A（推荐，随时可用）**：把 PSD 放进 `works/日期/` 并 push。
  构建时会自动收录；缺点是刷新页面后新图才出现，且需要重新构建。
- **方式 B（不重新构建）**：部署服务器上把新文件放进站点目录，然后运行
  `npx tsx scripts/build-index.ts --root <站点目录> --out <站点目录>/index-dates.json`。
  站点会在目录列表区域显示这些"已存在但尚未构建"的文件，因为它们没有缩略图
  和图层数据，只能下载。

## 日期/作品变多了会怎样

每天一张，一年就是 365 个日期。实测数据（`npm run bench:scale`，本机）：

| 作品数 | 构建耗时 | manifest | 预览图产物 | DOM 节点 | 首屏渲染 | JS 堆 |
|---|---|---|---|---|---|---|
| 25 | 2.6 s | 75 KB | 16 MiB | 298 | 1.0 s | 2.8 MiB |
| 50 | 3.6 s | 150 KB | 32 MiB | 573 | 1.0 s | 2.8 MiB |
| 100 | 7.2 s | 299 KB | 65 MiB | 1123 | 1.0 s | 3.3 MiB |
| 500（外推） | ~31 s | ~1.5 MB | **~324 MiB** | — | — | — |

- **构建不是瓶颈**：约 62 ms/作品，线性增长，500 个作品约半分钟，CI 完全够用。
- **浏览器也不吃力**：缩略图是 `loading="lazy"`，600 个作品时首屏只请求十几张图，
  JS 堆稳定在几 MB。
- **两个真正会先撑不住的地方**：
  1. **预览图产物体积**。约 0.65 MiB/作品，500 个作品就是 ~324 MiB。先撞上 GitHub
     "仓库建议 <1 GiB"和 LFS 流量配额。作品多到这个量级时，建议把
     `scripts/build-manifest.ts` 里的 `THUMB_EDGE`/`DISPLAY_EDGE` 调小
     （现在 480/1600），或只对最近的作品生成 `display` 预览图。
  2. **页面长度**。每个作品约 10.6 个 DOM 节点，500 个作品的滚动条会有约 32 万像素高。
- **画廊已分页**：首屏只渲染最新 30 个日期，底部有「显示更早的日期」按钮按需展开；
  用 URL 直接打开某个较早的作品时，会自动展开到那个日期，不会出现"选中的作品被分页藏起来"。
  实测 120 个作品（60 天）和 600 个作品（300 天）首屏都稳定在 **716 个 DOM 节点 /
  约 11 800 px**，与总量无关（`npm run verify:scale`）。

## 时间线

图库不只是「按日期分组」，整个页面就是一条练习时间线：

- **左侧时间线栏**（桌面端）：按年份分组，每个练习日一个节点，节点旁有作品数量与
  密度条；当前正在浏览的日期高亮（`IntersectionObserver` 滚动监听）。
- **置顶年月导航**：横向滚动的月份胶囊，点击跳到该月第一个日期；当前月份高亮。
  小屏幕上时间线节点收起，只保留这条月份导航。
- **连续练习统计**：当前连续天数、最长连续、练习天数、时间跨度——由完整的作品历史
  算出，不会因为分页而变小。
- 首屏有标题区与总览数字，卡片有滚动入场动画，整体支持 `prefers-reduced-motion`。

时间线只锚定**当前已渲染的日期**（分页之外的老日期点不到），但统计数字是全量的。

## 技术栈

Vite 8 · React 19 · TypeScript · Tailwind CSS 4 · [ag-psd](https://github.com/Agamnentzar/ag-psd)（读取 PSD）· @napi-rs/canvas（构建时渲染缩略图）· vitest · Puppeteer（端到端验收）

## 已知限制

- ag-psd **不会重绘**智能对象、矢量、文字、调整图层的效果——这些图层的像素是
  Photoshop 里烘焙好的，UI 会对这类作品给出提示；
- 超过 ~6 MP 的大图，图层查看器渲染的是**代理分辨率**，以保证交互流畅（图上会
  标明），构建时预览图仍是全分辨率；
- 浏览器无法复现的 PSD 混合模式（溶解、线性加深、亮光、实色混合、减去、划分等）
  会退化为近似效果，UI 会标注；
- 首次打开某作品的图层视图需要等待解码（1080×1350 约 0.25 s，A4@300dpi 约 1.3–2 s），
  期间先显示构建时预览图，界面不会卡住；同一作品第二次打开走 IndexedDB 缓存，几乎瞬时。
- **打开作品时会把所有可绘制图层（含 PSD 里默认隐藏的图层）解码一遍**，这样之后每次
  点眼睛图标都是纯重绘、不再等待。代价是图层很多的超大文件首次打开较久（例如
  18 层 / 8.7 MP 可能需要十几秒，期间有进度提示且界面可交互）。如果想改为
  "先解码可见图层、隐藏图层后台慢慢补"，这是一个小改动。

设计与实测依据见 [`DECISIONS.md`](./DECISIONS.md)。
