/* 营小商 · 小程序原型（纯 mock）唯一共享脚本
 * 经典 script（非 module），零依赖、零构建；file:// 直接打开可用。
 * 职责：按页面配置读取 fixture（fetch 优先、内联 JSON 兜底）、解析 state/articleId、
 * 四分支互斥显隐、五个页面渲染、导航与重试地址拼接、控制台 fixture-source 标记。
 * 语法口径：ES2017 及以下；不使用存储 API、不发起除本地 fixture 外的任何网络请求。
 */

/* 夹具目录按脚本自身位置定位：页面放在哪一层都指向同一个 fixtures/，不假设 cwd 与页面层级。
 * 经典 script 执行期 currentScript 有值；万一为空（动态注入场景）退回当前页面地址。 */
var SCRIPT_URL = (function () {
  var current = document.currentScript
  return current && current.src ? current.src : location.href
})()

var PAGES = {
  'home.html': { fixture: 'student.json', method: 'student.current', render: renderHome },
  'news.html': { fixture: 'news-list.json', method: 'news.list', render: renderNews },
  'news-detail.html': { fixture: 'news-detail.json', method: 'news.get', render: renderDetail },
  'ask.html': { fixture: 'attempts.json', method: 'questions.attempts', render: renderAsk },
  'profile.html': { fixture: 'profile.json', method: 'profile.get', render: renderProfile }
}

/* ---------- 基础工具 ---------- */

function str(value) {
  return value == null ? '' : String(value)
}

function decodeText(text) {
  try {
    return decodeURIComponent(text)
  } catch (error) {
    return text
  }
}

function getParam(name) {
  var search = location.search || ''
  if (search.charAt(0) === '?') search = search.slice(1)
  var pairs = search.split('&')
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue
    var eq = pairs[i].indexOf('=')
    var key = eq === -1 ? pairs[i] : pairs[i].slice(0, eq)
    var val = eq === -1 ? '' : pairs[i].slice(eq + 1)
    if (decodeText(key) === name) return decodeText(val)
  }
  return null
}

function normalizeState(raw) {
  if (raw === 'loading' || raw === 'error' || raw === 'empty') return raw
  return 'normal'
}

function currentPageName() {
  var path = location.pathname || ''
  var segments = path.split('/')
  return segments[segments.length - 1] || ''
}

function slot(name) {
  return document.querySelector('[data-slot="' + name + '"]')
}

function getBox(stateName) {
  var boxes = document.querySelectorAll('[data-state]')
  for (var i = 0; i < boxes.length; i++) {
    if (boxes[i] === document.body) continue
    if (boxes[i].getAttribute('data-state') === stateName) return boxes[i]
  }
  return null
}

/* 所有标签都必须带 .tag 基类：tone 类只负责配色，尺寸/边框/换行由基类承担。
 * 只写 tone 类会让标签退化成彩色纯文字；调用方显式传 'tag' 时不重复叠加。 */
function makeTag(className, text) {
  var tagEl = document.createElement('span')
  var tone = str(className).trim()
  tagEl.className = !tone || tone === 'tag' ? 'tag' : 'tag ' + tone
  tagEl.textContent = str(text)
  return tagEl
}

function makeLine(text) {
  var lineEl = document.createElement('p')
  lineEl.className = 'line'
  lineEl.textContent = str(text)
  return lineEl
}

function confidenceText(value) {
  return typeof value === 'number' && isFinite(value) ? Math.round(value * 100) + '%' : ''
}

function escapeAttr(text) {
  return str(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/* ---------- 枚举转中文标签 ---------- */

function statusLabel(status) {
  if (status === 'full') return '全文'
  if (status === 'partial') return '节选'
  if (status === 'unavailable') return '暂无正文'
  return status
}

function roleLabel(role) {
  if (role === 'core') return '核心'
  if (role === 'example') return '例证'
  if (role === 'mention') return '提及'
  return role
}

function reviewStatusLabel(status) {
  if (status === 'draft') return '待复核'
  if (status === 'reviewed') return '已认可'
  if (status === 'rejected') return '已驳回'
  return status
}

function growthStatusClass(status) {
  if (status === '进步') return 'tag-success'
  if (status === '停滞') return 'tag-warning'
  return 'tag-muted'
}

/* ---------- fixture 加载：JSON 为主通道，内联副本为 file:// 兜底 ---------- */

/* 只在同目录 fixtures/ 下取文件，不拼接任何外部地址；resolve 后一律落在本地路径上。 */
function fixtureUrl(name) {
  return new URL('../fixtures/' + name, SCRIPT_URL).href
}

function readInlineFixture(name) {
  var nodes = document.querySelectorAll('script[type="application/json"][data-fixture="' + name + '"]')
  for (var i = 0; i < nodes.length; i++) {
    try {
      return JSON.parse(nodes[i].textContent || 'null')
    } catch (error) {
      /* 不中断：可能还有另一段同名副本可解析；全失败时由调用方进 error 分支。
       * 这里必须留下痕迹，否则「页面空白」现场无从复盘。 */
      console.warn('fixture inline parse failed: ' + name + ' (' + error.message + ')')
    }
  }
  return null
}

/* 双通道：静态服务器下 fetch 到的是 fixtures/*.json 这个唯一编辑源，改 JSON 刷新即跟随；
 * file:// 下浏览器按不透明同源拦掉本地 fetch，此时退回页面内联副本，页面仍可双击打开。
 *
 * file:// 不先 fetch 而是直接判协议：Chromium 会为这次必然失败的请求打一条 console.error，
 * JS 里 catch 不到（那是浏览器自己打的），双击打开时控制台就不干净了。预判协议与「试了再回落」
 * 结果等价，但省掉一条无法消除的噪声。
 * 两条通道都失败才返回 null，由 boot() 走 error 分支。 */
function loadFixture(name) {
  if (location.protocol === 'file:') {
    return Promise.resolve(readInlineFixtureOrReport(name, 'file: protocol'))
  }
  return fetch(fixtureUrl(name))
    .then(function (response) {
      if (!response.ok) throw new Error('fixture http ' + response.status + ': ' + name)
      return response.json()
    })
    .then(function (data) {
      console.info('fixture-source: json')
      return data
    })
    .catch(function (error) {
      return readInlineFixtureOrReport(name, error.message)
    })
}

/* 内联兜底成功与失败都要留一条可读的控制台记录：标记必须如实反映本次真实来源。 */
function readInlineFixtureOrReport(name, reason) {
  var inline = readInlineFixture(name)
  if (inline != null) {
    console.info('fixture-source: inline-fallback (' + reason + ')')
    return inline
  }
  console.warn('fixture missing: ' + name + ' (' + reason + ')')
  return null
}

/* ---------- 四分支显隐 ---------- */

function show(stateName) {
  var boxes = document.querySelectorAll('[data-state]')
  for (var i = 0; i < boxes.length; i++) {
    var box = boxes[i]
    if (box === document.body) continue
    if (box.getAttribute('data-state') === stateName) {
      box.removeAttribute('hidden')
    } else {
      box.setAttribute('hidden', '')
    }
  }
  document.body.dataset.state = stateName
}

function removeFallback() {
  var fallback = document.getElementById('script-fallback')
  if (fallback && fallback.parentNode) fallback.parentNode.removeChild(fallback)
}

function fillLoading() {
  var box = getBox('loading')
  if (!box) return
  box.innerHTML =
    '<div class="skeleton">' +
      '<div class="skeleton-line"></div>' +
      '<div class="skeleton-line"></div>' +
      '<div class="skeleton-line"></div>' +
      '<div class="skeleton-line"></div>' +
      '<div class="skeleton-block"></div>' +
      '<div class="skeleton-block"></div>' +
    '</div>' +
    '<p class="state-loading-text">加载中（原型演示态）</p>'
}

function retryHref() {
  var path = location.pathname || ''
  var segments = path.split('/')
  var fileName = segments[segments.length - 1] || ''
  var search = location.search || ''
  var pairs = search.replace(/^\?/, '').split('&').filter(Boolean)
  var kept = []
  pairs.forEach(function (pair) {
    var eq = pair.indexOf('=')
    var key = eq === -1 ? pair : pair.slice(0, eq)
    if (decodeText(key) !== 'state') kept.push(pair)
  })
  return fileName + (kept.length ? '?' + kept.join('&') : '')
}

function fillError() {
  var box = getBox('error')
  if (!box) return
  box.innerHTML =
    '<div class="state-panel">' +
      '<h2 class="state-panel-title">暂时没拿到这条数据。</h2>' +
      '<p class="state-panel-desc">原型演示错误态：当前没有连接真实服务端，以下内容是占位。</p>' +
      '<div class="state-actions">' +
        '<a class="btn btn-primary" href="' + escapeAttr(retryHref()) + '">重试</a>' +
        '<a class="btn btn-secondary" href="../index.html">返回首页</a>' +
      '</div>' +
    '</div>'
}

function fillEmpty(cfg) {
  var box = getBox('empty')
  if (!box) return
  box.innerHTML = ''
  var fixture = cfg.fixture
  if (fixture === 'student.json') {
    box.innerHTML =
      '<div class="empty">暂无学生信息。</div>' +
      '<p><a class="empty-action" href="../index.html">返回入口总览</a></p>'
  } else if (fixture === 'news-list.json') {
    box.innerHTML =
      '<div class="empty">暂无新闻，Python 采集服务会在后台自动入库</div>' +
      '<p><a class="empty-action" href="../index.html">返回入口总览</a></p>'
  } else if (fixture === 'news-detail.json') {
    box.innerHTML =
      '<div class="empty">选择一条新闻查看原文与匹配证据</div>' +
      '<section class="block"><h2 class="block-title">知识点匹配</h2><div class="empty">尚未匹配</div></section>' +
      '<p><a class="empty-action" href="news.html">返回新闻列表</a></p>'
  } else if (fixture === 'attempts.json') {
    box.innerHTML =
      '<div class="empty">还没有作答记录，去完成一道题后再来看。</div>' +
      '<p><a class="empty-action" href="../index.html">返回入口总览</a></p>'
  } else if (fixture === 'profile.json') {
    box.innerHTML =
      '<section class="section"><h2 class="block-title">目标与约束</h2><div class="empty">还没有记录目标与约束。</div></section>' +
      '<section class="section"><h2 class="block-title">能力维度</h2><div class="empty">还没有形成能力快照。</div></section>' +
      '<section class="section"><h2 class="block-title">证据账本</h2><div class="empty">还没有学生能力证据。</div></section>' +
      '<p><a class="empty-action" href="../index.html">返回入口总览</a></p>'
  }
}

/* ---------- 首页：student.current ---------- */

function renderHome(data) {
  var d = data && typeof data === 'object' ? data : {}
  var name = str(d.name) || '学生'
  var nameSlot = slot('name')
  if (nameSlot) nameSlot.textContent = name

  var cohort = str(d.cohort)
  var studentId = str(d.studentId)
  var sub = ''
  if (cohort && studentId) sub = cohort + ' · ' + studentId
  else if (cohort) sub = cohort
  else if (studentId) sub = studentId
  var subSlot = slot('sub')
  if (subSlot) subSlot.textContent = sub
}

/* ---------- 新闻列表：news.list ---------- */

function appendNewsRow(container, title, sub) {
  var titleEl = document.createElement('div')
  titleEl.className = 'row-title'
  titleEl.textContent = str(title)
  container.appendChild(titleEl)
  if (sub) {
    var subEl = document.createElement('div')
    subEl.className = 'row-sub'
    subEl.textContent = sub
    container.appendChild(subEl)
  }
}

function renderNews(data) {
  var list = Array.isArray(data) ? data : []
  var countSlot = slot('count')
  if (countSlot) countSlot.textContent = '新闻（' + list.length + '）'

  var box = slot('list')
  if (!box) return
  box.innerHTML = ''

  if (list.length === 0) {
    var empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '暂无新闻，Python 采集服务会在后台自动入库'
    box.appendChild(empty)
    return
  }

  list.forEach(function (article) {
    var a = article && typeof article === 'object' ? article : {}
    var title = str(a.title) || '无标题新闻'
    var source = str(a.source)
    var date = str(a.published_at).slice(0, 10)
    var sub = source
    if (date) sub = source ? source + ' · ' + date : date
    var id = str(a.id)

    if (id) {
      var row = document.createElement('a')
      row.className = 'row'
      row.setAttribute('data-mock-source', 'news.list')
      row.setAttribute('data-replace', 'data-field')
      row.setAttribute('data-article-id', id)
      row.href = 'news-detail.html?articleId=' + encodeURIComponent(id)
      appendNewsRow(row, title, sub)
      box.appendChild(row)
    } else {
      var disabled = document.createElement('div')
      disabled.className = 'row row-disabled'
      disabled.setAttribute('data-replace', 'data-field')
      appendNewsRow(disabled, title, sub)
      box.appendChild(disabled)
    }
  })
}

/* ---------- 新闻详情：news.get ---------- */

function renderMatchCard(match) {
  var m = match && typeof match === 'object' ? match : {}
  var card = document.createElement('div')
  card.className = 'match-card'
  card.setAttribute('data-mock-source', 'news.get')
  card.setAttribute('data-replace', 'data-field')

  var head = document.createElement('div')
  head.className = 'match-head'

  var nameSpan = document.createElement('span')
  nameSpan.textContent = str(m.kpName) || str(m.kp_id)
  head.appendChild(nameSpan)

  var role = str(m.tag_role)
  if (role) head.appendChild(makeTag('tag-muted', roleLabel(role)))

  var conf = confidenceText(m.confidence)
  if (conf) {
    var confSpan = document.createElement('span')
    confSpan.className = 'match-meta'
    confSpan.textContent = conf
    head.appendChild(confSpan)
  }
  card.appendChild(head)

  var body = document.createElement('div')
  body.className = 'match-body'
  body.textContent = str(m.evidence_span)
  card.appendChild(body)

  var rationale = str(m.rationale)
  if (rationale) {
    var rationaleEl = document.createElement('div')
    rationaleEl.className = 'match-meta'
    rationaleEl.textContent = rationale
    card.appendChild(rationaleEl)
  }
  return card
}

function renderIdeologyRow(item) {
  var it = item && typeof item === 'object' ? item : {}
  var row = document.createElement('div')
  row.className = 'ideology-row'

  row.appendChild(makeTag('tag-muted', str(it.ideology_id)))

  var confSpan = document.createElement('span')
  confSpan.className = 'match-meta'
  confSpan.textContent = confidenceText(it.confidence)
  row.appendChild(confSpan)

  var evidence = document.createElement('p')
  evidence.textContent = str(it.evidence_span)
  row.appendChild(evidence)

  var rationale = str(it.rationale)
  if (rationale) {
    var rationaleEl = document.createElement('p')
    rationaleEl.className = 'match-meta'
    rationaleEl.textContent = rationale
    row.appendChild(rationaleEl)
  }
  return row
}

function renderDetail(data, articleId) {
  var d = data && typeof data === 'object' ? data : {}
  var article = d.article && typeof d.article === 'object' ? d.article : null
  var selected = article && articleId && str(article.id) === articleId ? article : null

  var selectedBox = slot('selected')
  var unselected = slot('unselected')

  if (!selected) {
    if (selectedBox) selectedBox.setAttribute('hidden', '')
    if (unselected) {
      unselected.removeAttribute('hidden')
      unselected.innerHTML = ''
      var empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '选择一条新闻查看原文与匹配证据'
      unselected.appendChild(empty)
    }
    return
  }

  if (unselected) {
    unselected.setAttribute('hidden', '')
    unselected.innerHTML = ''
  }
  if (selectedBox) selectedBox.removeAttribute('hidden')

  var titleSlot = slot('title')
  if (titleSlot) titleSlot.textContent = str(selected.title)

  var tagsSlot = slot('tags')
  if (tagsSlot) {
    tagsSlot.innerHTML = ''
    var source = str(selected.source)
    if (source) tagsSlot.appendChild(makeTag('tag-accent', source))
    var status = str(selected.content_status)
    if (status) tagsSlot.appendChild(makeTag('tag-muted', statusLabel(status)))
  }

  var urlSlot = slot('url')
  if (urlSlot) {
    urlSlot.innerHTML = ''
    var url = str(selected.url)
    if (url) {
      var link = document.createElement('a')
      link.className = 'origin-link'
      link.setAttribute('data-replace', 'data-field')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = '查看原文'
      urlSlot.appendChild(link)
    }
  }

  var contentSlot = slot('content')
  if (contentSlot) {
    contentSlot.innerHTML = ''
    var content = str(selected.content)
    if (content) {
      contentSlot.textContent = content
    } else {
      var contentEmpty = document.createElement('div')
      contentEmpty.className = 'empty'
      contentEmpty.textContent = '暂无正文'
      contentSlot.appendChild(contentEmpty)
    }
  }

  var matches = Array.isArray(d.matches) ? d.matches : []
  var matchesSlot = slot('matches')
  if (matchesSlot) {
    matchesSlot.innerHTML = ''
    if (matches.length === 0) {
      var matchEmpty = document.createElement('div')
      matchEmpty.className = 'empty'
      matchEmpty.textContent = '尚未匹配'
      matchesSlot.appendChild(matchEmpty)
    } else {
      matches.forEach(function (match) {
        matchesSlot.appendChild(renderMatchCard(match))
      })
    }
  }

  var ideology = Array.isArray(d.ideology) ? d.ideology : []
  var ideologySlot = slot('ideology')
  var ideologyBlock = slot('ideology-block')
  if (ideologySlot) ideologySlot.innerHTML = ''
  if (ideologyBlock) {
    if (ideology.length === 0) {
      ideologyBlock.setAttribute('hidden', '')
    } else {
      ideologyBlock.removeAttribute('hidden')
      ideology.forEach(function (item) {
        ideologySlot.appendChild(renderIdeologyRow(item))
      })
    }
  }
}

/* ---------- 问答：questions.attempts ---------- */

function renderAttempt(attempt) {
  var a = attempt && typeof attempt === 'object' ? attempt : {}
  var record = document.createElement('div')
  record.className = 'record'
  record.setAttribute('data-mock-source', 'questions.attempts')
  record.setAttribute('data-replace', 'data-field')

  var head = document.createElement('div')
  head.className = 'record-head'

  var score = typeof a.score === 'number' && isFinite(a.score) ? a.score : null
  if (score != null) {
    var correct = score >= 0.99
    /* 与其它标签共用 makeTag，避免这里手拼 class 时漏掉基类 */
    head.appendChild(makeTag(correct ? 'tag-success' : 'tag-warning', correct ? '答对' : '答错'))
  }

  var questionSpan = document.createElement('span')
  questionSpan.className = 'row-title'
  questionSpan.textContent = str(a.question_id)
  head.appendChild(questionSpan)

  var date = str(a.created_at).slice(0, 10)
  if (date) {
    var dateSpan = document.createElement('span')
    dateSpan.className = 'match-meta'
    dateSpan.textContent = date
    head.appendChild(dateSpan)
  }

  var toggle = document.createElement('button')
  toggle.className = 'record-toggle'
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.textContent = '展开'
  head.appendChild(toggle)
  record.appendChild(head)

  var body = document.createElement('div')
  body.className = 'record-body'
  body.setAttribute('hidden', '')

  var answerLine = document.createElement('p')
  answerLine.className = 'answer-line'
  answerLine.textContent = '你的答案：' + (str(a.answer) || '未作答')
  body.appendChild(answerLine)

  var feedback = a.feedback_json && typeof a.feedback_json === 'object' ? a.feedback_json : null
  var message = feedback && typeof feedback.message === 'string' && feedback.message ? feedback.message : ''
  if (message) {
    var feedbackLine = document.createElement('p')
    feedbackLine.className = 'feedback-line'
    feedbackLine.textContent = '反馈：' + message
    body.appendChild(feedbackLine)
  }

  record.appendChild(body)

  toggle.addEventListener('click', function () {
    var expanded = body.hasAttribute('hidden') ? false : true
    if (expanded) {
      body.setAttribute('hidden', '')
      toggle.textContent = '展开'
      toggle.setAttribute('aria-expanded', 'false')
    } else {
      body.removeAttribute('hidden')
      toggle.textContent = '收起'
      toggle.setAttribute('aria-expanded', 'true')
    }
  })

  return record
}

function renderAsk(data) {
  var list = Array.isArray(data) ? data : []
  var box = slot('records')
  if (!box) return
  box.innerHTML = ''

  if (list.length === 0) {
    var empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有作答记录，去完成一道题后再来看。'
    box.appendChild(empty)
    return
  }

  list.forEach(function (attempt) {
    box.appendChild(renderAttempt(attempt))
  })
}

/* ---------- 我的：profile.get ---------- */

function renderGoals(profile, box) {
  if (!box) return
  box.innerHTML = ''

  var goals = profile && Array.isArray(profile.goals) ? profile.goals : []
  var constraints = profile && Array.isArray(profile.constraints) ? profile.constraints : []
  var preferences = profile && typeof profile.preferences === 'object' && profile.preferences ? profile.preferences : {}
  var keys = Object.keys(preferences)

  if (goals.length === 0 && constraints.length === 0 && keys.length === 0) {
    var empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有记录目标与约束。'
    box.appendChild(empty)
    return
  }

  goals.forEach(function (goal) {
    box.appendChild(makeLine('· ' + str(goal)))
  })
  constraints.forEach(function (constraint) {
    box.appendChild(makeLine('约束：' + str(constraint)))
  })
  keys.forEach(function (key) {
    var value = preferences[key]
    box.appendChild(makeLine(key + '：' + (value == null ? '' : String(value))))
  })
}

function renderGrowth(growth, box) {
  if (!box) return
  box.innerHTML = ''

  if (growth.length === 0) {
    var empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有形成能力快照。'
    box.appendChild(empty)
    return
  }

  var grid = document.createElement('div')
  grid.className = 'growth-grid'

  growth.forEach(function (item) {
    var g = item && typeof item === 'object' ? item : {}
    var comp = g.competency && typeof g.competency === 'object' ? g.competency : null

    var card = document.createElement('div')
    card.className = 'growth-card'

    var head = document.createElement('div')
    head.className = 'growth-head'

    var nameSpan = document.createElement('span')
    nameSpan.className = 'row-title'
    nameSpan.textContent = comp ? str(comp.name) : ''
    head.appendChild(nameSpan)

    var status = str(g.status)
    if (status) head.appendChild(makeTag(growthStatusClass(status), status))
    card.appendChild(head)

    var level = document.createElement('div')
    level.className = 'growth-level'
    level.textContent = str(g.level)
    card.appendChild(level)

    var evidenceCount = typeof g.evidenceCount === 'number' && isFinite(g.evidenceCount) ? g.evidenceCount : 0
    var meta = document.createElement('div')
    meta.className = 'growth-meta'
    meta.textContent = '证据 ' + evidenceCount + ' 条'
    card.appendChild(meta)

    var latest = g.latestEvidence && typeof g.latestEvidence === 'object' ? g.latestEvidence : null
    if (latest && str(latest.excerpt)) {
      var quote = document.createElement('blockquote')
      quote.className = 'growth-quote'
      quote.textContent = str(latest.excerpt)
      card.appendChild(quote)
    }

    grid.appendChild(card)
  })

  box.appendChild(grid)
}

function renderEvidence(evidence, competencies, box) {
  if (!box) return
  box.innerHTML = ''

  if (evidence.length === 0) {
    var empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有学生能力证据。'
    box.appendChild(empty)
    return
  }

  var nameById = {}
  competencies.forEach(function (comp) {
    if (comp && typeof comp === 'object') nameById[str(comp.id)] = str(comp.name)
  })

  evidence.forEach(function (item) {
    var e = item && typeof item === 'object' ? item : {}
    var el = document.createElement('div')
    el.className = 'evidence-item'

    var tags = document.createElement('div')
    tags.className = 'evidence-tags'

    var compName = nameById[str(e.competency_id)] || '能力维度'
    tags.appendChild(makeTag('tag-accent', compName))
    if (str(e.level)) tags.appendChild(makeTag('tag', str(e.level)))
    if (str(e.strength)) tags.appendChild(makeTag('tag', str(e.strength)))
    var reviewLabel = reviewStatusLabel(str(e.review_status))
    if (reviewLabel) tags.appendChild(makeTag('tag', reviewLabel))
    el.appendChild(tags)

    var excerpt = document.createElement('p')
    excerpt.className = 'evidence-excerpt'
    excerpt.textContent = str(e.excerpt)
    el.appendChild(excerpt)

    var rationale = str(e.rationale)
    if (rationale) {
      var rationaleEl = document.createElement('p')
      rationaleEl.className = 'evidence-rationale'
      rationaleEl.textContent = rationale
      el.appendChild(rationaleEl)
    }

    var date = str(e.occurred_at).slice(0, 10)
    if (date) {
      var dateSpan = document.createElement('span')
      dateSpan.className = 'evidence-date'
      dateSpan.textContent = date
      el.appendChild(dateSpan)
    }

    box.appendChild(el)
  })
}

function renderProfile(data) {
  var d = data && typeof data === 'object' ? data : {}
  var profile = d.profile && typeof d.profile === 'object' ? d.profile : null
  var competencies = Array.isArray(d.competencies) ? d.competencies : []

  var nameSlot = slot('profile-name')
  var cohortSlot = slot('profile-cohort')
  if (profile) {
    if (nameSlot) nameSlot.textContent = str(profile.name) || '学生'
    if (cohortSlot) {
      var cohort = str(profile.cohort)
      cohortSlot.textContent = cohort
      if (cohort) cohortSlot.removeAttribute('hidden')
      else cohortSlot.setAttribute('hidden', '')
    }
  } else {
    if (nameSlot) nameSlot.textContent = '学生'
    if (cohortSlot) {
      cohortSlot.textContent = ''
      cohortSlot.setAttribute('hidden', '')
    }
  }

  renderGoals(profile, slot('goals'))
  renderGrowth(Array.isArray(d.growth) ? d.growth : [], slot('growth'))
  renderEvidence(Array.isArray(d.evidence) ? d.evidence : [], competencies, slot('evidence'))
}

/* ---------- 启动分发 ---------- */

function boot() {
  removeFallback()

  var cfg = PAGES[currentPageName()]
  var state = normalizeState(getParam('state'))
  var articleId = getParam('articleId')

  if (!cfg) {
    fillError()
    show('error')
    return
  }

  if (state === 'loading') {
    fillLoading()
    show('loading')
    return
  }

  loadFixture(cfg.fixture).then(function (data) {
    if (data == null) {
      fillError()
      show('error')
      return
    }
    if (state === 'error') {
      fillError()
      show('error')
      return
    }
    if (state === 'empty') {
      fillEmpty(cfg)
      show('empty')
      return
    }
    try {
      cfg.render(data, articleId)
    } catch (error) {
      fillError()
      show('error')
      return
    }
    show('normal')
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
