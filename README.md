# 耗材库 · 3D打印原材料管理

> 一个单 HTML 文件，零依赖，打开即用的 3D 打印耗材库存管理工具。

![预览](https://img.shields.io/badge/单文件-HTML-blue) ![拓竹](https://img.shields.io/badge/拓竹-199种耗材-green) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 这是什么？

如果你有一堆 3D 打印耗材，却总是记不清「这卷料盘还剩多少」「上次买的那个颜色叫什么」「某种材质还有库存没」——这个工具就是为你准备的。

**核心特点：**

- **零安装**：一个 `.html` 文件，浏览器打开直接用，无需服务器
- **数据本地**：所有数据存在浏览器的 `localStorage`，不联网，不上传
- **拓竹专属**：内置 199 种拓竹（Bambu Lab）官方耗材数据，输入编号自动识别颜色/材质
- **标签系统**：给耗材打标签（如「常用」「哑光」「柔性」），快速分类筛选

---

## 功能一览

| 功能 | 说明 |
|------|------|
| 🎨 颜色可视化 | 每种耗材显示真实色块，一眼看出颜色 |
| 📦 库存追踪 | 记录数量、重量、是否还有料盘 |
| 🔍 搜索筛选 | 按名称/品牌搜索，按材质/标签/库存状态筛选 |
| 📋 网格/列表视图 | 两种视图自由切换 |
| ⚡ 批量添加 | 一次性导入多个耗材，支持拓竹编号自动识别 |
| 🏷️ 标签管理 | 自定义标签，支持批量打标、颜色分类 |
| ✏️ 编辑模式 | 开启编辑模式后可直接修改卡片上的数据 |
| 🗑️ 批量操作 | 多选后批量删除 |

---

## 快速上手

### 1. 下载文件

直接下载 `filament-manager.html`，用浏览器打开即可。

```
# 或者 clone 整个仓库
git clone https://github.com/your-username/filament-manager.git
cd filament-manager
# 用浏览器打开 filament-manager.html
```

### 2. 添加第一条耗材

点击右上角 **「添加耗材」** 按钮：

- **颜色名称**：随便起个你好记的名字（如「樱花粉」）
- **拓竹编号**（可选）：输入 5 位数字编号（如 `16103`），会自动填充官方颜色和材质
- **品牌**：拓竹 / 其他品牌都可以
- **材质**：PLA / PETG / ABS / TPU 等
- **颜色**：手动选色，或由编号自动填充
- **重量 / 数量 / 是否有料盘**：按实际情况填写

### 3. 批量导入（推荐）

如果你手头有一批耗材要一次性录入，点击 **「批量添加」**：

1. 在文本框里每行输入一条耗材名称，支持直接粘贴：
   ```
   白色 16103
   PETG 黑色 30105
   哑光海蓝 11600
   自定义颜色名
   ```
2. 带有拓竹 5 位编号的会自动识别颜色和材质
3. 点击 **「下一步：确认」** 预览解析结果
4. 在确认面板里可以调整颜色、品牌，删除不想要的条目
5. 点击 **「全部添加」** 完成导入

### 4. 筛选和搜索

- **搜索框**：输入耗材名称或品牌名关键词
- **材质筛选**：点击 PLA / PETG / ABS 等按钮
- **标签筛选**：点击自定义标签快速过滤
- **库存状态**：「有库存」筛出数量 > 0 的，「无料盘」筛出料盘已用完的

### 5. 编辑和管理

- 点击右上角 **「编辑」** 开启编辑模式，卡片上的名称/数量/品牌可直接点击修改
- 长按或勾选卡片可多选，然后批量删除
- 点击 **「标签」** 管理你的标签库，可以新增/删除/改颜色

---

## 拓竹编号识别

工具内置了 **199 种**拓竹官方耗材数据，覆盖以下系列：

| 系列 | 编号前缀 | 示例 |
|------|---------|------|
| PLA Basic | 10xxx | 10100 玉白 |
| PLA Matte（哑光） | 11xxx | 11600 哑光海蓝 |
| PLA Silk+（丝绸） | 12xxx | 12200 丝绸糖果红 |
| PLA CF（碳纤维） | 13xxx | 13100 碳纤黑 |
| PLA Lite | 16xxx | 16103 白色 |
| PETG Basic | 30xxx | 30105 黑色 |
| PETG HF（高速） | 33xxx | 33100 白色 |
| ABS | 40xxx | 40100 白色 |
| ASA | 42xxx | — |
| TPU 95A HF | 51xxx | 51200 红色 |
| PC | 65xxx | — |
| PA6-GF | 72xxx | — |
| … 等共 19 个系列 | | |

**输入格式**均支持：
- 纯编号：`16103`
- 名称+编号：`白色 16103`、`PETG黑色30105`

---

## 技术实现

整个项目只有一个 HTML 文件，没有任何外部依赖框架。

### 数据存储

所有耗材数据存储在浏览器的 `localStorage`，key 为 `filaments`。每次修改都会立即持久化，刷新页面数据不会丢失。

```javascript
// 保存
localStorage.setItem('filaments', JSON.stringify(data));

// 读取
const data = JSON.parse(localStorage.getItem('filaments') || '[]');
```

### 核心数据结构

每条耗材记录是一个 JS 对象：

```javascript
{
  id: 1,
  name: '玉白',          // 颜色名称
  bambuCode: '10100',    // 拓竹官方编号（可选）
  brand: '拓竹',         // 品牌
  material: 'PLA',       // 材质
  color: '#FFFFFF',      // 颜色 Hex 值
  weight: 1000,          // 重量（克）
  qty: 3,                // 数量（卷）
  hasSpool: true,        // 是否有料盘
  tags: ['基础色', '常用'] // 标签数组
}
```

### 拓竹编号数据库

内置一个静态数组 `bambuFilaments`，共 199 条记录，每条格式为：

```javascript
["10100", "Jade White", "#FFFFFF", "PLA Basic"]
//  编号      英文名        颜色Hex     所属系列
```

同时有一个 `bambuNameCn` 映射对象，把英文名转为中文（如 `"Jade White" → "玉白"`）。

### 批量解析逻辑

批量添加时，每行文字通过正则 `/^(.*?)(\d{5})$/` 匹配，提取末尾的 5 位数字作为拓竹编号，然后在 `bambuByCode` 字典中查找对应的颜色/材质信息。

```javascript
const m = s.match(/^(.*?)(\d{5})$/);
if (m) {
  const code = m[2];
  const filament = bambuByCode[code]; // 查数据库
  // 自动填充颜色、材质、中文名称
}
```

### 颜色生成

批量添加同一类型多个耗材时，会通过 HSL 色相偏移自动生成不同颜色，避免所有条目颜色相同：

```javascript
function generateColor(baseHex, i, total) {
  // 把 Hex 转成 HSL → 按 360/total 步长旋转色相 → 转回 Hex
}
```

### 界面渲染

整个 UI 通过纯 JS 动态渲染，没有使用任何前端框架：

- `renderAll()` — 主渲染入口，每次数据变化时调用
- `renderGrid()` / `renderList()` — 分别渲染网格和列表视图
- `renderStats()` — 更新顶部统计栏
- `renderMaterialFilters()` / `renderTagFilters()` — 动态生成筛选按钮

---

## 数据备份与迁移

数据存在 `localStorage`，换浏览器/换电脑后数据不会跟着走。建议定期导出：

1. 打开浏览器开发者工具（F12）
2. 在 Console 输入：
   ```javascript
   copy(localStorage.getItem('filaments'))
   ```
3. 把复制到剪贴板的 JSON 保存到文件即可备份

恢复时：
```javascript
localStorage.setItem('filaments', '【粘贴你的备份JSON】');
location.reload();
```

---

## License

MIT — 随意使用、修改、分发。
