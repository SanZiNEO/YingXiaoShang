# R19 品牌与文案

> 状态：MVP（本轮）
> 依赖：无（横切所有上屏文案）
> 代码：`packages/shared/src/brand.ts`、`apps/desktop/package.json`、`apps/desktop/electron-builder.yml`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/src/App.tsx`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 从头到尾只有一个称呼：**营小商**。窗口标题、聊天气泡作者、左栏标题、安装包、快捷方式、开始菜单都是这四个字。
- 没有副标题、没有英文产品名、没有「XX 助手 / XX 老师 / 智能体平台」这类修饰。
- 不出现学校名、学院名、课程编号，也不说「小程序」，只说桌面软件。
- 不出现任何内部分工称呼（教练 / 导师 / 专家 / 子智能体 / 多智能体），也不出现工具名、置信度、步骤 read/write。
- 界面文案是中文，且是学生能照做的话（「点左下角『设置』」而不是「配置凭据」）。

## 2. 落位（提示词 / 工具 / skill / 数据）

属于**提示词 + 配置数据**，不属于工具：

- 提示词：身份句与自称写死在 `packages/agent/agents/mentor.md`，明确「我是营小商」「不主动提学校名、学院名、课程编号」（`mentor.md:182-183`）。
- 配置数据：产品名、英文名、代号、home 变量、目录名、库文件名集中在 `packages/shared/src/brand.ts`，代码按字段读取，不各写一份。
- 安装包元数据：`apps/desktop/package.json` 的 `productName` 与 `electron-builder.yml` 的 `productName` / `shortcutName` / `appId`。
- 工具层不产生产品文案；工具名只出现在模型侧，不上屏。

## 3. 行为（一轮里怎么发生）

1. 窗口创建：`BrowserWindow` 的 `title` 写「营小商」（`apps/desktop/src/main/index.ts:120`）；页面 `<title>` 同值（`apps/desktop/src/renderer/index.html:6`）。
2. 渲染层：左栏标题、消息作者名、空状态引导语直接写「营小商」（`App.tsx:1131`、`:1219`、`:1318`、`:1423`、`:1459`；`workspace.tsx:537`）。
3. 设置弹窗：标题「设置」，说明 Key 只存本机、环境变量优先；不出现产品代号（`App.tsx:1595-1601`）。
4. 打包：`productName` 决定安装包文件名、安装目录名与开始菜单项；`shortcutName` 决定桌面快捷方式名（`electron-builder.yml:3`、`:33`）。
5. 改名时：先改 `brand.ts`，再按第 4 节清单逐处替换硬编码，最后重打包；只改一处会出现「窗口叫新名、安装包叫旧名」。

## 4. 契约（工具签名、数据结构、字段、命令）

**品牌常量（`packages/shared/src/brand.ts:5-14`）**

```ts
export const BRAND = {
  name: '营小商',
  nameEn: 'Ying Xiaoshang',
  codename: 'learning-agent',
  tagline: '用真实案例学会营销',
  profile: 'learning-agent',
  homeEnv: 'LEARNING_AGENT_HOME',
  homeDir: '.learning-agent',
  dbFile: 'learning.db',
} as const
```

- `name` 是唯一上屏名；`tagline` 不作为副标题上屏。
- `nameEn` / `codename` / `profile` 只用于内部标识，不上屏。
- `homeEnv` / `homeDir` / `dbFile` 是数据契约（见 [R17](R17-local-data.md)），改名等同迁移。

**安装包元数据**

| 位置 | 字段 | 当前值 |
|---|---|---|
| `apps/desktop/package.json:3` | `productName` | 营小商 |
| `apps/desktop/package.json:5` | `description` | 营小商桌面端：用真实新闻和教材知识点陪学生练营销判断 |
| `apps/desktop/electron-builder.yml:2` | `appId` | com.learningagent.yingxiaoshang |
| `apps/desktop/electron-builder.yml:3` | `productName` | 营小商 |
| `apps/desktop/electron-builder.yml:33` | `nsis.shortcutName` | 营小商 |

**换名时必须一起改的清单**

1. `packages/shared/src/brand.ts`：`name`（必改）；`nameEn`、`tagline`、`codename`、`profile` 按需；`homeEnv` / `homeDir` / `dbFile` 只在决定换数据目录时改，并同步迁移逻辑。
2. `apps/desktop/package.json`：`productName`、`description`。
3. `apps/desktop/electron-builder.yml`：`appId`、`productName`、`shortcutName`。
4. `apps/desktop/src/main/index.ts:120`：窗口 `title`。
5. `apps/desktop/src/renderer/index.html:6`：页面 `<title>`。
6. `apps/desktop/src/renderer/src/App.tsx`：`:1131`、`:1219`、`:1318`、`:1423`、`:1459`。
7. `apps/desktop/src/renderer/src/workspace.tsx:537`：空状态文案。
8. `apps/desktop/src/main/index.ts:55`：旧设置迁移路径里的 `@learning-agent`（包名一改，老 Key 就找不到）。
9. `package.cmd`、`scripts/package-desktop.mjs`：控制台输出文案。
10. 仓库 `README.md` 与 `docs/`：说明性文字。

**上屏硬约束**

| 约束 | 依据 |
|---|---|
| 只称「营小商」，不出现英文名、代号、副标题 | 本文件第 1 节 |
| 不出现学校名、学院名、课程编号 | `packages/agent/agents/mentor.md:183` |
| 不说「小程序」，说桌面软件 | 原则 §6 |
| 不出现分工称呼（教练/导师/专家/子智能体/多智能体） | 原则 §1、§6 |
| 不出现工具名、置信度、步骤 read/write、内部枚举 | 原则 §6 |
| 中文文案必须可执行（说清点哪里、填什么） | 本文件第 1 节 |

## 5. 边界（不做什么、失败怎么表现）

- 不做品牌运营：没有 slogan、没有关于页、没有官网链接、没有更新公告。
- 不把 `tagline` 当副标题上屏，也不在标题后加「Beta / MVP / 预览版」。
- 不出现第三方模型品牌名作为产品名（设置页可以出现 `DEEPSEEK_API_KEY` 字段名，因为那是要填的变量，不是产品称呼）。
- 打包元数据缺字段时：`productName` 缺失会退回 `@learning-agent/desktop`，安装包与快捷方式会带内部包名，属于验收失败，不是可接受降级。
- 改名后旧数据目录不会自动迁移；界面不提示「数据不见了」，需要在发布说明里写清（见 [R17](R17-local-data.md) 第 7 节）。

## 6. 验收（场景 → 期望）

1. **上屏称呼唯一**：打开桌面端 → 窗口标题、左栏标题、聊天气泡作者名、空状态引导语全部是「营小商」；截图里搜不到英文名、代号、副标题。
2. **禁词扫描为零**：
   ```sh
   grep -rniE "教练|导师|专家|子智能体|多智能体|小程序|学校|学院|大学" apps/desktop/src
   ```
   期望 0 命中（2026-10-25 实测为 0）。
3. **安装包一致**：`pnpm run package:desktop` 后 `release/` 里安装包名为「营小商 Setup 0.1.0.exe」；安装后开始菜单项、桌面快捷方式、安装目录名都是「营小商」。
4. **英文元数据不上屏**：安装包属性里的 `appId` 是 `com.learningagent.yingxiaoshang`，但界面任何位置都不出现 `Ying Xiaoshang`、`learning-agent`、`@learning-agent/desktop`。
5. **换名演练可执行**：把 `brand.ts` 的 `name` 改成测试名 → 按第 4 节清单搜索，能一次性列出所有残留位置；改完重打包，窗口标题与安装包名一致。

## 7. 现状与差距（代码事实）

| 事实 | 位置 |
|---|---|
| 品牌字段集中定义 | `packages/shared/src/brand.ts:5-14` |
| 窗口标题硬编码「营小商」 | `apps/desktop/src/main/index.ts:120` |
| 页面标题硬编码 | `apps/desktop/src/renderer/index.html:6` |
| 渲染层 5 处硬编码称呼 | `App.tsx:1131`、`:1219`、`:1318`、`:1423`、`:1459` |
| 空状态文案硬编码 | `workspace.tsx:537` |
| 安装包 productName / shortcutName | `apps/desktop/electron-builder.yml:3`、`:33` |
| 安装包 appId 含英文 | `electron-builder.yml:2` |
| 提示词禁止提学校名 | `packages/agent/agents/mentor.md:183` |
| `brand.ts` 只被数据库与一个死页面读取 | `packages/db/src/index.ts:821-824`、`apps/desktop/src/renderer/src/pages.tsx:674` |
| `apps/desktop/src` 无分工称呼与校名（实测 0 命中） | `grep -rniE "教练|导师|专家|子智能体|小程序|学校|学院|大学" apps/desktop/src` |

差距：

1. **改名要改两套**：`brand.ts` 存在，但窗口标题与渲染层仍硬编码，`App.tsx` 不读 `BRAND.name`；`brand.ts` 的 `name` 只在死页面 `pages.tsx:674` 被引用，`nameEn` / `tagline` / `codename` / `profile` 全仓无消费者（只有 `homeEnv` / `homeDir` / `dbFile` 被数据库用）。
2. **`tagline` 与 `nameEn` 是死字段**：要么上屏（违反本需求），要么删掉；现在既不上屏也不删除，容易被误当成产品定位。
3. **`pages.tsx` 有双份死代码**：`apps/desktop/src/renderer/src/pages.tsx` 与 `packages/ui/src/client/pages.tsx` 同名、内容相近但不完全一致，且都不在活路径上（见代码卫生检查第 2 节）；改名时容易漏改或误改。
4. **打包注释与事实不符**：`electron-builder.yml:15` 写「6 份角色提示词（1 个入口 + 5 个分工）」，实际 `packages/agent/agents/` 只有 `mentor.md` 一份，而且这段注释本身带分工叙述。
5. **打包仍收死资产**：`electron-builder.yml:9` 的 `templates/**` 对应 `ArtifactService.renderTemplate()`，后者已无活调用方。
6. **控制台文案英文**：`package.cmd` 的 `Done. Installer is in the release folder.` 与 `scripts/package-desktop.mjs` 的英文日志；这些不上学生屏幕，但与中文口径不一致。
7. **`appId` 与包名不可随意改**：`appId` 决定 Windows 上的应用标识，改名会变成「另一个应用」，升级安装不覆盖旧版。

## 8. MVP 范围与后续

**MVP 做到哪**

- 唯一称呼「营小商」；窗口标题、渲染层、安装包、快捷方式一致；无学校名、无分工称呼、无「小程序」。
- 换名清单可执行（第 4 节十项）。
- 验收见第 6 节五条。

**后续**

- 把 `App.tsx` 的硬编码换成 `BRAND.name`，`index.html` 用构建期注入，做到「只改 `brand.ts` 就完成改名」。
- 删 `tagline` / `nameEn` 或明确其唯一用途（例如只用于安装包文件属性）。
- 删除双份 `pages.tsx` 与 `templates/**` 打包项，缩小改名面。
- 增加一个静态检查脚本：上屏目录命中禁词即失败（比人工 grep 稳）。

**明确不做**

- 品牌视觉体系、logo、启动图、官网、更新公告。
- 多语言界面；英文只允许出现在安装包内部标识与必须填写的环境变量名上。
- 为某个学校/课程做定制品牌版本。

相关：[R16 对话与三栏界面](R16-conversation-ui.md)、[R17 本地数据](R17-local-data.md)、[R20 运行与验收](R20-run-verify.md)。
