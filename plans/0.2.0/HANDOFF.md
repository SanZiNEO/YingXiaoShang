# 交接文档（新对话从这里开始）

> 写给下一个接手的人 / 下一个 AI 会话。**读完这一页就能接着干，不用翻聊天记录。**
> 最后更新：2026-11-05

---

## 一、这是什么项目

**营小商**：给市场营销专业学生用的桌面 AI 助教（Electron）。学生像聊天一样提问，
它调用课程知识库、真实新闻、教材原文来回答；要成果时给一份能带走的页面或题目集。

- 客户：魏老师（任课老师）。硬约束：**不出现学校名字**。
- 使用者：老师带的班级。当前用「解压即用包」分发。
- 团队：用户（学生，全权负责）、SanZiNEO（学长，考研中，基本不看 GitHub）、天才（高中同学，提产品意见）。

## 二、现在到什么程度

| 项 | 状态 |
|---|---|
| 交付包 | ✅ `营小商-双击即用-1105b.zip`：解压 → 双击 `营小商.exe` → 用 |
| A 轮（原生运行时能不能接） | ✅ 关单 |
| B 轮（原生链路跑通） | 🔵 B1–B4、B6 通过；B5 取消部分通过 |
| C 轮（切片一：学情档案） | ✅ 已修（`211d36f`），见 `ROUND-C-ARCHIVE.md` |
| 提速第一批 | ✅ 一次读够（`b100426`）：3 概念 30s → 7s |
| D/E/F 轮 | ☐ 未开工 |
| 手机端 | ☐ 需要服务端，评估见 `track-0-delivery.md` |

**技术上的两个大未知已排除**：不用写 provider 适配层（A2 实测）、原生循环能跑通（B3/B4，1.7 秒）。

## 三、当前产品的四个已知缺陷（都有证据）

| 编号 | 现象 | 证据 | 修在哪轮 |
|---|---|---|---|
| F03 | 单轮最多 11 次模型调用（`maxRounds=10` + 收口），查资料就慢 | 实测 4 轮 121–205 秒，vs 不查资料 2 秒 | B |
| F11 | 聊天写 `record_json: {}`，记录器直接 break，学情永不更新 | 27/27 轮 2 字节 `{}`，11 个 ledger 全 0/N | **✅ 已修** |
| F04/F05 | 查资料期间界面不显示任何东西；工具事件还会清掉已出的字 | `App.tsx:723-726`、`team.ts` 提示词 | D |
| F01/F02 | 无超时、无取消、`finish` 一律当 stop | `llm.ts`、`tool-loop.ts` | B/D |

**待查**：「同一会话连续 4 轮左右之后卡住」。已排除并发、SQLite 锁、历史增长、残留 running。
最可能是**模型 API 限流**（每轮最多 11 次调用，4 轮 20–40 次），而这版没有 429 处理与退避。
排查工具：包里的 `调试启动.bat`（带日志），卡住时看最后几十行。

## 四、目录与关键文件

```
docs/
├── onboarding.md                          ← 新人入门（目标/架构/思路/工作流）
├── principles/single-agent.md             ← 唯一设计原则
├── requirements/R01–R21                   ← 需求口径
├── agent-runtime-audit-and-rebuild-guide.md ← 学长写的调查 + 重建指导（697 行，权威）
└── README.md                              ← 文档地图与权威顺序

plans/0.2.0/
├── README.md                    ← 方向、两条轨道、六轮表
├── 主代理-轮次任务模板.md        ← 派单协议（五要素、验收、红线）
├── review-kit.md                ← 独立复核用（贴给新对话就能审）
├── decisions.md                 ← 已裁决 6 条（谁定的、依据）
├── pending-discussions.md       ← 未决项（P-1 已交付，P-2/P-4/P-5/P-6 待定）
├── ROUND-A-MAP / A-CONCLUSION   ← A 轮：挂什么、怎么挂、删什么
├── ROUND-B-MAP                  ← B 轮：进度与阻塞
├── track-0-delivery.md          ← 交付包、事故记录、手机端评估
└── incident-slow-and-stuck.md   ← 「慢/卡」的完整排查（含实测表）

tools/
├── verify-doc-refs.py      ← 文档「文件:行号」引用校验
├── verify-case-quotes.py   ← 案例引文回原文校验
└── turn-duration.py        ← 逐轮耗时统计（读 learning.db，只读）
```

## 五、命令

```bash
pnpm run typecheck                          # 全仓库类型检查
python tools/turn-duration.py               # 每轮耗时（判断有没有真的变快）
python tools/verify-doc-refs.py             # 文档引用校验
pnpm exec tsx scripts/verify-settings-bom.ts # 配置读取自查
```

**注意**：本机 `pnpm install` 会卡在 851/851（`.bin` 不生成），**不要把它当第一步**；
仓库里现有依赖够跑类型检查和脚本，但**打不出新的安装包**——打包必须在完整环境做。

## 五之半、git 推送（本机特有，务必先做）

`~/.gitconfig` 里有 `http.https://github.com.proxy=http://127.0.0.1:10809`。
代理一关，`git push` 会报 `Failed to connect to github.com port 443 via 127.0.0.1`——
看起来像 GitHub 挂了，其实是本地代理配置。

仓库里已经设了本地覆盖（不影响你其它项目）：

```bash
git config --local "http.https://github.com.proxy" ""
```

排查顺序：`git ls-remote --heads origin` → 通就直接推；不通再检查代理端口
（10809/7890/7897）是否在听，都关着说明代理没开，关掉覆盖走直连即可。
2026-11-07 实测直连 `github.com:443` 与 `api.github.com` 都通。

## 六、五个必须知道的坑

1. **用户消息必须带 `role: 'user'` 和 `source: { kind: 'user' }`**。缺 `role` 时能进收件箱，
   但适配器会报 `DeepSeek Messages transport failed`——看起来像网络问题，其实是结构问题。
2. **流式帧取 `frame.chunk.text`**，`frame.type` 是 `chunk` 不是 `text-delta`；
   帧里有循环引用，别整帧 `JSON.stringify`（会抛错并静默吞掉处理函数）。
3. **别同时订阅根 `ctx` 和 `agent.ctx`** 的 `agent/assistant-stream`，每个 delta 会重复两遍。
4. **交付脚本不能依赖文件编码/代码页**。上一版 bat 用 GBK 写死中文路径，别人机器上写错目录；
   现在用码点拼（`[char]0x8425+...`）或编译 exe。
5. **「我这儿能用」不是验收标准**。网络、代码页、是否装了运行时都会不同。要验就在目标环境验。

## 七、下一步该做什么（按顺序）

1. **等同学反馈**（老师要的 N=8），反馈会决定优先级：
   - 「慢」为主 → 做 D 轮的事件/超时/取消 + B 轮删 maxRounds
   - 「答得不对」为主 → 做 C 轮的判据与引文
   - 「要手机」为主 → 评估只读网页版（`track-0-delivery.md` 末尾）
2. **排查「连续 4 轮卡住」**：用 `调试启动.bat` 抓日志，重点看有没有 429/超时。
3. **B5 的判别实验**：只订一处事件、打印帧计数，确认唯一订阅点（D 轮前置）。
4. 然后才是 C 轮接业务。

## 八、几条不能破的规矩

- **不自己搓 agent 循环**：用 DSH 原生件，业务做成工具 / skill / 上下文（`decisions.md` D-3）。
- **不设固定轮次/请求数/时长上限**（审计 §4.4.3）。
- **能复用就别自研**；先全量堆上去再砍（`decisions.md` D-5）。
- **该自己判断的别外包**：有现成答案的取舍不要拿去问人（`主代理-轮次任务模板.md` §八）。
- **不许把「挂上了」说成「跑通了」**；没跑过的验证不许说通过。

## 九、当前唯一阻塞（需要人）

`pending-discussions.md`：
- **P-2** 27 条 `example/` 链接 clone 后是死链，要不要摘 README 进 `30-research/`（可延后）
- **P-4** 旧循环要不要留 fallback（结论：不留，靠 git 回滚）
- **P-5** 历史产物迁移（切换前先清点 + 备份）

其余没有阻塞项，可以自行推进。
