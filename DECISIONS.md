# 设计与实测决策记录（Lead 维护）

本项目所有关键决策都基于本机实测数据，而非猜测。原始实测脚本与结果见
`/home/ubuntu/projects/.psd-bench/`（`bench.mjs`、`browser/index.html`、`FINDINGS.md`）。

## 硬约束

1. **GitHub Pages 无法在运行时列目录**（没有 directory index API）。
   → "自动读取目录和文件"必须在构建时完成：`scripts/build-manifest.ts` 扫描
   `works/YYYY-MM-DD/*.psd` 生成 `public/generated/manifest.json`。
2. **部署服务器上新增的文件无法被静态站发现**。因此额外提供
   `scripts/build-index.ts` 生成 `index-dates.json`，由 VPS 侧定时执行，
   站点读取它来显示"仓库里已存在但尚未重新构建"的作品。这是唯一能让
   "新上传即出现"和"纯静态托管"共存的方式。
3. **GitHub 单文件硬上限 100 MiB**，超过直接拒绝 push。因此 PSD 走 Git LFS
   （`.gitattributes`），并且 `scripts/build-manifest.ts` 对超过 ~40 MP 的
   文档跳过位图解码，避免构建时 OOM。

## 实测性能（Chromium 152 headless，本机）

| 操作 | 耗时 |
|---|---|
| 只读结构/图层名（`skipLayerImageData`） | 0.1–2.8 ms（几乎免费） |
| 完整解码（合成图 + 全部图层） | 4–7 MP/s：1.9 MP→318 ms，8.7 MP→1.3–2.0 s |
| 合成图 PNG 编码 | 0.4–0.5 s（A4@300dpi） |
| ImageBitmap 传给主线程 | 0.0–0.4 ms |
| 已解码图层重绘到 1500px 代理画布 | 数十 ms |

由此确定三条产品级约束，并写进了两个工作流的验收标准：

- **首屏必须用构建时缩略图**，绝不为了列表去解码 PSD；
- **解码只能在 Worker 里**（同步、阻塞主线程、4–7 MP/s）；
- **图层开关只能重绘，不能重新解码**（解码一次缓存每层位图）。

## 接口冻结

- `shared/manifest.ts` — manifest 数据契约（`MANIFEST_VERSION = 1`）；
- `shared/paths.ts` — `base`/URL 拼接（GitHub Pages 子路径部署的关键）；
- `shared/blend.ts` — PSD 混合模式 → `globalCompositeOperation` 映射。

`shared/*` 是冻结接口，任何一方都不得修改；需变更必须由 Lead 统一改。

**图层顺序**：ag-psd 的 `children` 数组是"图层最上层在前"，与 Photoshop 图层面板
顺序一致，因此 manifest 按原数组顺序输出，**不反转**。图层查看器按该顺序自上而下渲染
（后面的先画、前面的后画），保证叠加结果正确。

**混合模式**：`globalCompositeOperation` 的合法值必须是空格分隔形式
（`color-burn`、`hard-light`），写成 `colorBurn` 会被静默忽略并回退到 `source-over`
——这是图层查看器最容易"看起来正常但导出错"的地方。浏览器无法复现的模式
（溶解、线性加深、亮光、实色混合、减去、划分等）在 `shared/blend.ts` 标记为近似，
UI 会提示。

## 示例 PSD 为什么需要自己写合成图（重要教训）

两个库各缺一半，**单独用任何一个都会得到"看起来能跑但实际是坏的"示例**：

| 写入方式 | 图层 alpha | 合成图 |
|---|---|---|
| ag-psd `writePsdBuffer()` | ✅ 正确（透明区读回 `rgba(0,0,0,0)`） | ❌ 分层文档的合成区全黑 |
| psd-tools `create_pixel_layer()` | ❌ ag-psd 读回全不透明（透明区变黑） | ✅ 正确 |
| **本项目 `scripts/samples/psd-write.ts`** | ✅ ag-psd 写 | ✅ 自己渲染后拼进文件 |

另外 `psd_tools.append()` 是"加到组的最上层"，所以图层必须按**面板顺序**追加；
按直觉写成 `reversed(LAYOUT)` 会把不透明底色放到最上层，查看器正确地最后绘制它，
结果整张图变成一个平色块。

**这个 bug 曾经在 e2e 全绿的情况下漏掉过一次**，因为当时每条断言只证明"点了图层画面
变了"。现在补了两条真正的回归守卫（都在 `scripts/e2e-verify.ts`）：

1. 缩略图必须是真实像素（不能是纯黑合成图）；
2. **实时合成必须与构建时预览图相似**（亮度差 ≤25 且颜色分桶数 ≥ 预览的 40%）
   —— 平色块只有个位数颜色分桶，一测就露。

## 验证覆盖（最终版）

| 验证 | 结果 |
|---|---|
| `npm run build`（manifest + index + tsc + vite build） | 通过；worker 独立 chunk 303 kB，主包 288 kB（gzip 89 kB） |
| `npm run test:unit` | 6 个文件 / 103 个用例通过 |
| `npm test:e2e`（真实 headless Chrome 驱动 dist/） | **21/21 通过** |
| `npm run verify:proxy`（临时 8.3 MP PSD） | 通过：3520×2360 → 画布 1500×1006，5 层各解码一次，切换图层不再解码 |
| `npm run verify:scale`（合成 manifest） | 通过：120 作品/60 天与 600 作品/300 天首屏都稳定在 30 个日期组、约 1 150 个 DOM 节点 |

e2e 覆盖：日期分组渲染、缩略图真实解码（且**不是纯黑**）、**实时合成与构建时预览相似**、
打开作品列出 6 个图层、画布合成、点击图层改变像素且 aria-pressed 翻转、再点一次像素完全还原、
主线程最大帧间隔 20 ms、**全部 3 个作品的下载 PSD 与源文件 md5 完全一致**、无页面报错；
点击作品到首帧 29 ms。

解码次数实测（客户端在真实 Chrome 读取工具栏 `data-decode-count`）：
载入 6 层作品 = 6 次；关掉一个图层 = 6；再打开 = 6；刷新后（IndexedDB 命中）= **0**。
即切换图层绝不重新解码，这条不变量同时被单元测试锁定
（"redraws 30 visibility changes without a single extra decode"）。

## 已知限制（诚实声明）

- ag-psd **不会重绘**智能对象/矢量/文字/调整图层的效果，这些图层的像素是 PS 里
  烘焙好的；UI 对这类作品给出提示。
- 图层查看器渲染的是**代理分辨率**（>6 MP 的文档按最长边 1500px 缩放）而非全分辨率，
  以保证交互流畅（界面会标明"代理分辨率"）。这是刻意取舍，不是缺陷。
- 打开作品时会**解码全部可绘制图层（含 PSD 中默认隐藏的）**，以换取"此后切换零等待"；
  图层极多的大文件首次打开会较久（18 层 / 8.7 MP 约十几秒，期间显示构建时预览图、
  界面仍可交互）。这是可调整的取舍，不是缺陷。
- 代理合成用 canvas 混合近似 PSD 合成，浏览器无法复现的混合模式（溶解、线性加深、
  亮光、实色混合、减去、划分等）会退化并在 UI 标注；构建时生成的缩略图/预览图是
  PS 真实合成结果，作为"正确性基准"始终可见。
- IndexedDB 的 LRU 淘汰、配额超限、隐私模式降级都有代码保护，但未在受限环境下实测。
- 本机未安装 git-lfs（`git lfs` 不可用），因此 LFS 只完成了 `.gitattributes` 配置与
  文档，未实际推送验证。首次使用需 `git lfs install`。
- GitHub Actions 未真实运行（本地不是 GitHub 仓库）：workflow 已做 YAML 结构、
  内联脚本 `bash -n`、BASE_PATH 推导多分支等静态与逻辑级验证，但真实 CI 运行未验证。
