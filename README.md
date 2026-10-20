# PCB 爆炸图查看器

把 **ODB++** 数据在浏览器 / Electron 中沿 Z 轴「炸开」成多层，用于快速核对叠层结构、网络连通与层间间距，并直接导出 **1:1 实际尺寸的矢量 PDF 图纸**。

面向 Windows 7 离线环境（Electron 22 为最后一个支持 Win7 的版本）。

---

## 功能

- **爆炸展开 / 平面展开** — 各层沿 Z 轴等距层叠，或在 XY 平面内按网格铺开
- **网络高亮** — 按 ODB++ 网表重建网络并跨层合并，同名网络共享一色，每个网名只显示一次
- **最小间距计算** — 选中两个网络，逐层求最近点对与最小间距，并在三维视图中标注
- **图纸导出** — 印制板图（全部铜箔层）/ 组件图（顶底丝印），页序按真实叠层从上至下
- **原生矢量 PDF** — 不经 SVG / jsPDF 等中间层，直接写 PDF 路径运算符，放大不失真
- **技术要求管理** — 预置条目勾选 + 自定义条目，可一键复制勾选内容

---

## 技术栈

| 分类 | 技术 |
|---|---|
| 前端 | React 18 · TypeScript 5（strict）· Vite 5 |
| 三维 | three.js 0.169 · @react-three/fiber · @react-three/drei |
| 桌面 | Electron 22 · electron-builder 24（portable） |
| 压缩 | JSZip |

---

## 快速开始

```bash
npm install        # 安装依赖
npm run dev        # 开发模式，默认 http://localhost:5173
```

浏览器打开后，把 ODB++ 目录（或对应的 `.zip`）**拖入左侧拖放区**即可。

> 目录结构需包含 `matrix/matrix` 与 `steps/<step>/layers/<name>/features`。

### 构建与打包

```bash
npm run build      # 类型检查 + 构建前端到 dist/
npm run preview    # 预览构建产物
npm run dist:win7  # 打包 Win7 x64 便携版 exe → release/
```

---

## 使用说明

### 视图

| 模式 | 说明 |
|---|---|
| **爆炸展开** | 各层沿 Z 轴等距排开，可用「爆炸间距」滑块调整层间距 |
| **平面展开** | 各层在平面内按网格铺开，便于横向对比 |

侧栏各区块均可折叠，展开状态会被记住（存于 `localStorage`）。

### 网络高亮

点击网络名前的复选框即可高亮。显式网络（网表中有真实名称）按名称跨层合并，共有一种颜色；以 `Net` 开头的合成网络（解析器为未绑定网名的孤立铜块生成的占位名）不参与高亮。

### 最小间距

勾选**恰好两个**网络后，会出现「计算最小间距」按钮。点击后逐层计算两网的最近距离与最近点对，结果列在面板中，并在三维视图里用连线标注。

几何上把图元统一分解为三类填充形状——圆盘、胶囊（走线/圆弧）、多边形（矩形/八角焊盘/铺铜，支持内孔）——再两两求最近点。

### 图纸导出

| 图纸 | 内容 | 页序 |
|---|---|---|
| **印制板图** | 全部铜箔层（含负片） | TOP → MID1…MIDn → BOTTOM |
| **组件图** | 顶层 + 底层丝印 | 顶层丝印 → 底层丝印 |

导出的 PDF **页面尺寸恒等于板框实际尺寸**：594mm 的板在「实际大小 / 100%」打印时页面即为 594mm。图形会按四周留白设定轻微内缩（详见下方「PDF 四周留白」）。

---

## 配置：PDF 四周留白

导出图纸时在页面四周预留的留白带宽度，单位 **pt（PDF 用户空间坐标，1pt = 1/72 英寸 ≈ 0.3528mm）**。

```json
{
  "top": 8,
  "bottom": 10,
  "left": 12,
  "right": 14
}
```

### 布局模型：固定画幅 + 内缩缩放

**页面尺寸恒等于板框实际尺寸**（A2 即 594mm × 420mm），不因留白而增大；图形按下面两式内缩，四周腾出留白带：

```
sx = 1 - (left + right) / W      W = 板宽（mm 换算为 pt）
sy = 1 - (top  + bottom) / H     H = 板高（mm 换算为 pt）
```

因此四条留白带的实际宽度**精确等于**配置值。

> 用于验证的 A2 图纸（594 × 420mm = 1684.14 × 1190.57pt）实际结果：
> `sx = 1 - 26/1684.14 = 0.984562`，`sy = 1 - 18/1190.57 = 0.984881`，
> 页面仍为 1684.14 × 1190.57pt（594.13 × 420.01mm），与未缩放前完全一致。

`top`/`bottom`/`left`/`right` 各自独立，因此 `sx` 与 `sy` 通常不完全相等，图形会有极轻微的非等比缩放（A2 上两向相差约 0.03%，肉眼不可辨）。这是为了**严格执行四边留白设定**而保留的行为。

**文件位置**（按优先级从高到低查找）：

1. `PORTABLE_EXECUTABLE_DIR` —— electron-builder 便携版 exe 所在目录
2. exe 同级目录
3. 开发态：项目根目录

首次运行若未找到配置，程序会自动在首选可写目录生成一份默认配置。修改后**无需重新打包**，下次导出即生效。

也兼容 `{ "margins": { ... } }` 的包裹写法；非法值（负数、非数字）会逐项回退到默认值。留白合计超过板宽/高时会被等比收窄，避免出现反向缩放。

---

## 目录结构

```
src/
  App.tsx                 状态编排与业务流程
  components/
    Collapsible.tsx       可折叠面板（渐进式披露）
    DropZone.tsx          拖放 / 选择 ODB++
    ExplosionView.tsx     三维视图（react-three-fiber）
    LayerPanel.tsx        视图模式与图层显隐
    NetPanel.tsx          网络高亮与间距计算
    ExportPanel.tsx       PDF 导出
    TechPanel.tsx         技术要求条目
  lib/
    odb.ts                ODB++ 解析、网络重建、纹理渲染
    spacing.ts            双网络最小间距几何
    pdfExport.ts          原生矢量 PDF 生成
    pdfConfig.ts          四周留白配置读取
    layers.ts             图层类型、配色与叠层排序
    geometry.ts           板框包围盒
    nets.ts / tech.ts     网络与技术要求数据结构
  styles.css              设计令牌与全局样式
electron/
  main.cjs                主进程（窗口、IPC）
  preload.cjs             contextBridge 只读配置桥
  pdf-config.cjs          配置定位、解析与默认写入
resources/                打包资源（应用图标 icon.png / icon.ico）
public/                   前端静态资源（favicon、默认 pdf-config.json）
scripts/                  验证脚本
```

---

## 实现要点

### ODB++ 解析

- 坐标以英寸存储、孔径以 mil 存储，统一换算为 mm（×25.4 / ×0.0254）
- 网表常为 GBK 编码，先按 UTF-8 严格解码，失败再回退 GBK
- 支持的孔径符号：`rect` / `square` / `oval` / `oct` / `donut` / `r`（圆）
- 铜箔的多轮廓（外轮廓 + 内孔）按独立 surface 拆分，正确渲染灌铜内孔

### 网络重建

ODB++ 网表的 points 段给出「某位置焊盘属于某网络」的权威信息。解析器用空间网格把焊盘中心匹配到种子点，再用并查集按端点精确重合连通走线与焊盘；铜箔则取落在其内部焊盘的众数网名。

刻意**不使用**基于邻近容差的连通判断——那会把只隔正常安全间距的不同网络铜箔误连在一起。

### 图层颜色

ODB++ 用 `#Layer_Color=<十进制>` 定义图层颜色，字节序为 **`0xBBGGRR`**（非通常的 RRGGBB）。

判据：TOP 层为 `255`（`0x0000FF`）→ 蓝色分量 0、红色分量 255 = 红；BOTTOM 层为 `16711680`（`0xFF0000`）→ 蓝。这与「顶层红、底层蓝」的行业惯例一致。

数据中的颜色**仅用于导出图纸**；三维爆炸图仍使用内置预设色，两者互不影响。

### 图纸页序

按 ODB++ `matrix` 的 `ROW` 升序，即物理叠层由上至下。注意 `LayerMeta.order` 是三维视图的视觉叠放提示（数值越小越靠下），方向相反，不能用来排图纸页序。

### 原生矢量 PDF

- 圆与圆弧用三次贝塞尔近似（KAPPA 常数），内容流经 FlateDecode 压缩
- 铺铜内孔用 evenodd（`f*`）一次填充
- 负片层 = 板框减去空隙，同样用 `f*`
- 白底导出时丝印/钢网替换为深色，保证浅色层在白纸上可辨

---

## 验证脚本

全部为一次性 Node 脚本，用 esbuild 现场打包 `src/lib/*.ts` 后直接调用，因此验证的就是生产代码路径。

```bash
node scripts/color_test.mjs        # 网络配色：互异性与稳定性
node scripts/verify_export.mjs     # PDF 结构：页数、纯矢量、evenodd、旋转、配色
node scripts/verify_odb_bind.mjs   # 焊盘网名绑定正确性（需样例数据）
node scripts/verify_odb_surface.mjs# 铺铜多轮廓解析（需样例数据）
node scripts/verify_pdf.mjs        # 真实数据导出 PDF（需样例数据）
node scripts/verify_silk.mjs       # 丝印白底配色（需样例数据）
node scripts/verify_spacing.mjs    # 间距几何单元测试（需样例数据）
node scripts/verify_cdp.mjs        # 浏览器端到端导出（需样例数据）
node scripts/verify_flat.mjs       # 平面展开视图（需样例数据）
```

> 标注「需样例数据」的脚本要求项目根目录存在 ODB++ 样例（`odb/` 目录或 `odb.zip`）。
> 样例数据因体积与版权原因**未纳入版本库**（见 `.gitignore`）。

---

## 已知限制

- 仅支持 **ODB++**，不支持 Gerber / Excellon
- 便携版每次运行会解压到临时目录，因此配置锚定在 `PORTABLE_EXECUTABLE_DIR`
- 「平面网格」布局固定为 A4，用于多图层缩略总览，不按实际尺寸打印
- 无自动化测试框架，验证依赖 `scripts/` 下的脚本手工执行

---

## 许可

未指定。
