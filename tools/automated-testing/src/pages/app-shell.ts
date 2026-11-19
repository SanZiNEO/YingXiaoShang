import type { Locator, Page } from 'playwright'

export type WorkspaceKind = 'overview' | 'artifacts' | 'evidence' | 'process' | 'files'

export type DragSide = 'sidebar' | 'workspace'

export interface CitationRef {
  index: number
  type: string
}

/**
 * 应用外壳与工作区：所有选择器只允许出现在 pages 层。
 * 定位优先级：业务 data-* 钩子 → role/aria-label → 稳定文本。
 * 禁用：nth-child、坐标点击、易变文案。
 */
export class AppShell {
  constructor(readonly page: Page) {}

  get body(): Locator {
    return this.page.locator('body')
  }

  get composer(): Locator {
    return this.page.locator('[data-testid="composer-input"]')
  }

  get sendButton(): Locator {
    return this.page.locator('[data-testid="composer-send"]')
  }

  get stopButton(): Locator {
    return this.page.locator('[data-action="stop"]').first()
  }

  get profileEntry(): Locator {
    return this.page.locator('[data-testid="nav-profile"]')
  }

  get settingsEntry(): Locator {
    return this.page.locator('[data-testid="nav-settings"]')
  }

  get newChatEntry(): Locator {
    return this.page.locator('[data-testid="nav-new-chat"]')
  }

  get overviewEntry(): Locator {
    return this.page.locator('[aria-label="任务概览"]').first()
  }

  get newTabButton(): Locator {
    return this.page.locator('[data-testid="tab-new"]')
  }

  get workspaceAside(): Locator {
    return this.page.locator('[data-tab-id]').first().locator('xpath=ancestor::aside[1]')
  }

  get messageNodes(): Locator {
    return this.page.locator('[data-message-role]')
  }

  get streamingBubble(): Locator {
    return this.page.locator('[data-streaming="true"]').first()
  }

  get settingsDialog(): Locator {
    return this.page.locator('[data-testid="settings-model"]').locator('xpath=ancestor::div[2]')
  }

  async waitReady(timeoutMs = 20000): Promise<void> {
    await this.composer.waitFor({ state: 'visible', timeout: timeoutMs })
  }

  async fillComposer(text: string): Promise<void> {
    await this.composer.fill(text)
  }

  async sendMessage(text: string): Promise<void> {
    await this.fillComposer(text)
    await this.sendButton.click()
  }

  async messages(): Promise<Array<{ role: string; text: string }>> {
    return await this.messageNodes.evaluateAll((nodes) =>
      nodes.map((node) => ({
        role: node.getAttribute('data-message-role') ?? '',
        text: node.textContent ?? '',
      })),
    )
  }

  async openProfile(): Promise<void> {
    await this.profileEntry.click()
    await this.page.getByRole('button', { name: /回到对话/ }).first().waitFor({ state: 'visible' })
  }

  async backToChat(): Promise<void> {
    await this.page.getByRole('button', { name: /回到对话/ }).first().click()
  }

  async openSettings(): Promise<void> {
    await this.settingsEntry.click()
    await this.page.getByRole('heading', { name: '设置' }).waitFor({ state: 'visible' })
  }

  async startNewChat(): Promise<void> {
    await this.newChatEntry.click()
  }

  async bridgeKeys(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const api = (window as unknown as { learning?: Record<string, unknown> }).learning
      return api ? Object.keys(api) : []
    })
  }

  async sessionIds(): Promise<string[]> {
    return await this.page.locator('[data-testid="session-item"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-session-id') ?? ''),
    )
  }

  async openSession(sessionId: string): Promise<void> {
    await this.page.locator(`[data-testid="session-item"][data-session-id="${sessionId}"]`).first().click()
  }

  async tabIds(): Promise<string[]> {
    return await this.page.locator('[data-tab-id]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-tab-id') ?? ''),
    )
  }

  async waitForTabId(tabId: string, timeoutMs = 20000): Promise<void> {
    await this.page.locator(`[data-tab-id="${tabId}"]`).first().waitFor({ state: 'visible', timeout: timeoutMs })
  }

  /** 工作区第一次打开前没有标签栏；先用顶栏「任务概览」把工作区挂起来。 */
  async ensureWorkspace(timeoutMs = 20000): Promise<void> {
    if ((await this.page.locator('[data-tab-id]').count()) === 0) {
      await this.overviewEntry.click()
    }
    await this.page.locator('[data-tab-id]').first().waitFor({ state: 'visible', timeout: timeoutMs })
  }

  async openMenu(): Promise<void> {
    await this.ensureWorkspace()
    if ((await this.page.locator('[data-testid="tab-menu-item"]').count()) === 0) {
      await this.newTabButton.click()
    }
    await this.page.locator('[data-testid="tab-menu-item"]').first().waitFor({ state: 'visible' })
  }

  async openKind(kind: WorkspaceKind): Promise<void> {
    await this.openMenu()
    await this.page.locator(`[data-testid="tab-menu-item"][data-kind="${kind}"]`).click()
  }

  async openArtifact(artifactId: string): Promise<void> {
    await this.openKind('artifacts')
    await this.page
      .locator(`[data-testid="artifact-item"][data-artifact-id="${artifactId}"]`)
      .first()
      .click()
  }

  async openCitation(index: number): Promise<void> {
    await this.openKind('evidence')
    await this.page.locator(`[data-testid="citation-item"][data-citation-index="${index}"]`).first().click()
  }

  /** P1-07：枚举本轮引用条目，index 取 data-citation-index，type 取 data-citation-type。 */
  async citations(): Promise<CitationRef[]> {
    return await this.page.locator('[data-testid="citation-item"]').evaluateAll((nodes) =>
      nodes.map((node, fallbackIndex) => ({
        index: Number(node.getAttribute('data-citation-index') ?? fallbackIndex),
        type: node.getAttribute('data-citation-type') ?? '',
      })),
    )
  }

  /** P1-07：按引用类型 + 序号点击某条引用（先切到依据/引用标签）。 */
  async openCitationByType(type: string, index: number): Promise<void> {
    await this.openKind('evidence')
    await this.page
      .locator(`[data-testid="citation-item"][data-citation-type="${type}"][data-citation-index="${index}"]`)
      .first()
      .click()
  }

  async exportActive(format: 'md' | 'docx' | 'html'): Promise<void> {
    await this.page.locator('[data-testid="workspace-export"]').click()
    await this.page.locator(`[data-testid="export-format"][data-format="${format}"]`).click()
  }

  async openLocalFile(): Promise<void> {
    await this.openMenu()
    await this.page.locator('[data-testid="tab-menu-open-local"]').click()
  }

  async closeTab(tabId: string): Promise<void> {
    await this.page.locator(`[data-tab-id="${tabId}"] [role="button"]`).first().click()
  }

  /** P1-13：按标签 id 精确定位标签按钮（五个列表类 kind 的标签 id 即 kind 字符串）。 */
  async tabById(tabId: string): Promise<Locator> {
    return this.page.locator(`[data-tab-id="${tabId}"]`).first()
  }

  async questionSet(): Promise<Locator> {
    return this.page.locator('[data-testid="question-set"]').first()
  }

  /** 逐题作答：有选项就点第一个，没有选项就写一句可判分的简答。返回提交所需的答案数组。 */
  async answerAllQuestions(): Promise<Array<{ questionId: string; answer: string }>> {
    const sections = this.page.locator('[data-testid="question-set"] section[data-question-id]')
    const count = await sections.count()
    const answers: Array<{ questionId: string; answer: string }> = []
    for (let index = 0; index < count; index += 1) {
      const section = sections.nth(index)
      const questionId = (await section.getAttribute('data-question-id')) ?? ''
      const options = section.locator('[data-testid="answer-option"]')
      const inputs = section.locator('[data-testid="answer-input"]')
      if ((await options.count()) > 0) {
        const option = options.first()
        const answer = (await option.textContent())?.replace(/^[A-Z]\.\s*/, '').trim() ?? ''
        await option.click()
        answers.push({ questionId, answer })
      } else if ((await inputs.count()) > 0) {
        const answer = `作答 ${index + 1}：这是自动化测试写入的答案。`
        await inputs.first().fill(answer)
        answers.push({ questionId, answer })
      } else {
        answers.push({ questionId, answer: '' })
      }
    }
    return answers
  }

  async submitQuestions(): Promise<void> {
    await this.page.locator('[data-testid="question-submit"]').click()
  }

  async evidenceIds(): Promise<string[]> {
    return await this.page.locator('[data-testid="evidence-item"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-evidence-id') ?? ''),
    )
  }

  async reviewEvidence(evidenceId: string, verdict: 'accept' | 'reject'): Promise<void> {
    await this.page.locator(`[data-evidence-id="${evidenceId}"] [data-testid="evidence-${verdict}"]`).click()
  }

  // ---------------------------------------------------------------------------
  // P1-10 分栏手柄：role=separator + data-side；data-dragging 仅在拖动中为 "true"。
  // ---------------------------------------------------------------------------

  dragHandle(side: DragSide): Locator {
    return this.page.locator(`[role="separator"][data-side="${side}"]`)
  }

  /** 读取手柄当前 data-dragging 状态。 */
  async dragHandleDragging(side: DragSide): Promise<boolean> {
    return (await this.dragHandle(side).getAttribute('data-dragging')) === 'true'
  }

  /** 键盘调宽：先聚焦手柄，再按方向键（渲染层步长 16px）。 */
  async resizeColumn(side: DragSide, direction: 'left' | 'right'): Promise<void> {
    const handle = this.dragHandle(side)
    await handle.focus()
    await handle.press(direction === 'left' ? 'ArrowLeft' : 'ArrowRight')
  }

  /** 双击手柄复位该列宽度。 */
  async resetColumn(side: DragSide): Promise<void> {
    await this.dragHandle(side).dblclick()
  }

  /**
   * 读取 localStorage 中的列宽数值；解析失败或缺键返回 undefined。
   * sidebar 存纯数字字符串；workspace 存 JSON（{px} 优先，其次 {ratio}）。
   */
  async layoutNumber(side: DragSide): Promise<number | undefined> {
    return await this.page.evaluate((target: DragSide) => {
      const key = target === 'sidebar'
        ? 'yingxiaoshang.layout.sidebar'
        : 'yingxiaoshang.layout.workspace'
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return undefined
        if (target === 'workspace') {
          const parsed: unknown = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') {
            const record = parsed as Record<string, unknown>
            if (typeof record.px === 'number' && Number.isFinite(record.px)) return record.px
            if (typeof record.ratio === 'number' && Number.isFinite(record.ratio)) return record.ratio
          }
          return undefined
        }
        const value = Number(raw)
        return Number.isFinite(value) ? value : undefined
      } catch {
        return undefined
      }
    }, side)
  }

  /** 读取某侧栏的实际渲染宽度（px）；侧栏未挂载时返回 undefined。 */
  async columnWidth(side: DragSide): Promise<number | undefined> {
    const aside = side === 'sidebar'
      ? this.newChatEntry.locator('xpath=ancestor::aside[1]')
      : this.workspaceAside
    if ((await aside.count()) === 0) return undefined
    return await aside.evaluate((node) => node.getBoundingClientRect().width)
  }
}
