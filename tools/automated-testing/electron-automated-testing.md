# 自动化测试

> 来源：<https://www.electronjs.org/zh/docs/latest/tutorial/automated-testing>
>
> 抓取时间：2026-11-18
>
> 说明：以下为页面正文原文，仅整理为 Markdown 格式；代码示例保留原样。

测试自动化是一种验证您的应用是否如你预期那样正常工作的有效方法。Electron 已然不再维护自己的测试解决方案，本指南将会介绍几种方法，让您可以在 Electron 应用上进行端到端自动测试。

## 使用 WebDriver 接口

引自 [ChromeDriver - WebDriver for Chrome](https://chromedriver.chromium.org/)：

> WebDriver 是一款开源的支持多浏览器的自动化测试工具。它提供了操作网页、用户输入、JavaScript 执行等能力。ChromeDriver 是一个实现了 WebDriver 与 Chromium 联接协议的独立服务。它也是由开发了 Chromium 和 WebDriver 的团队开发的。

有几种方法可以使用 WebDriver 设置测试。

### 使用 WebdriverIO

[WebdriverIO](https://webdriver.io/)（WDIO）是一个自动化测试框架，它提供了一个 Node.js 软件包用于测试 Web 驱动程序。它的生态系统还包括各种插件（例如报告器和服务），可以帮助你把测试设置放在一起。

If you already have an existing WebdriverIO setup, it is recommended to update your dependencies and validate your existing configuration with how it is [outlined in the docs](https://webdriver.io/docs/desktop-testing/electron).

#### Install the test runner

If you don't use WebdriverIO in your project yet, you can add it by running the starter toolkit in your project root directory:

- npm

```bash
npm init wdio@latest ./
```

- Yarn

```bash
yarn create wdio@latest ./
```

This starts a configuration wizard that helps you put together the right setup, installs all necessary packages, and generates a `wdio.conf.js` configuration file. Make sure to select *"Desktop Testing - of Electron Applications"* on one of the first questions asking *"What type of testing would you like to do?"*.

#### 将 WDIO 连接到 Electron 应用程序

After running the configuration wizard, your `wdio.conf.js` should include roughly the following content:

`wdio.conf.js`

```js
export const config = {

  // ...

  services: ['electron'],

  capabilities: [{

    browserName: 'electron',

    'wdio:electronServiceOptions': {

      // WebdriverIO can automatically find your bundled application

      // if you use Electron Forge or electron-builder, otherwise you

      // can define it here, e.g.:

      // appBinaryPath: './path/to/bundled/application.exe',

      appArgs: ['foo', 'bar=baz']

    }

  }]

  // ...

}
```

#### 编写测试

Use the [WebdriverIO API](https://webdriver.io/docs/api) to interact with elements on the screen. The framework provides custom "matchers" that make asserting the state of your application easy, e.g.:

```js
import { browser, $, expect } from '@wdio/globals'

describe('keyboard input', () => {

  it('should detect keyboard input', async () => {

    await browser.keys(['y', 'o'])

    await expect($('keypress-count')).toHaveText('YO')

  })

})
```

Furthermore, WebdriverIO allows you to access Electron APIs to get static information about your application:

```js
import { browser } from '@wdio/globals'

describe('trigger message modal', async () => {

  it('message modal can be triggered from a test', async () => {

    await browser.electron.execute(

      (electron, param1, param2, param3) => {

        const appWindow = electron.BrowserWindow.getFocusedWindow()

 electron.dialog.showMessageBox(appWindow, {

          message: 'Hello World!',

          detail: `${param1} + ${param2} + ${param3} = ${param1 + param2 + param3}`

        })

      },

      1,

      2,

      3

    )

  })

})
```

#### 运行测试

执行命令：

```bash
npx wdio run wdio.conf.js
```

WebdriverIO helps launch and shut down the application for you.

#### More documentation

Find more documentation on Mocking Electron APIs and other useful resources in the [official WebdriverIO documentation](https://webdriver.io/docs/desktop-testing/electron).

### 使用 Selenium

[Selenium](https://www.selenium.dev/) 是一个 Web 自动化框架，以多种语言公开与 WebDriver API 的绑定方式。Node.js 环境下，可以通过 NPM 安装 `selenium-webdriver` 包来使用此框架。

#### 运行 ChromeDriver 服务

为了与 Electron 一起使用 Selenium，你需要下载 `electron-chromedriver` 二进制文件并运行它：

- npm

```bash
npm install --save-dev electron-chromedriver

./node_modules/.bin/chromedriver

Starting ChromeDriver (v2.10.291558) on port 9515

Only local connections are allowed.
```

- Yarn

```bash
yarn add --dev electron-chromedriver

./node_modules/.bin/chromedriver

Starting ChromeDriver (v2.10.291558) on port 9515

Only local connections are allowed.
```

Remember the port number `9515`, which will be used later.

#### 将 Selenium 连接到 ChromeDriver

接下来，把 Selenium 安装到你的项目中：

- npm

```bash
npm install --save-dev selenium-webdriver
```

- Yarn

```bash
yarn add --dev selenium-webdriver
```

在 Electron 下使用 `selenium-webdriver` 和其平时的用法并没有大的差异，只是你需要手动设置如何连接 ChromeDriver，以及 Electron 应用的查找路径：

`test.js`

```js
const webdriver = require('selenium-webdriver')

const driver = new webdriver.Builder()

  // The "9515" is the port opened by ChromeDriver.

  .usingServer('http://localhost:9515')

  .withCapabilities({

    'goog:chromeOptions': {

      // 这里填您的Electron二进制文件路径。

      binary: '/Path-to-Your-App.app/Contents/MacOS/Electron'

    }

  })

  .forBrowser('chrome') // note: use .forBrowser('electron') for selenium-webdriver <= 3.6.0

  .build()

driver.get('https://www.google.com')

driver.findElement(webdriver.By.name('q')).sendKeys('webdriver')

driver.findElement(webdriver.By.name('btnG')).click()

driver.wait(() => {

  return driver.getTitle().then((title) => {

    return title === 'webdriver - Google Search'

  })

}, 1000)

driver.quit()
```

## 使用 Playwright

[Microsoft Playwright](https://playwright.dev/) 是一个端到端的测试框架，使用浏览器特定的远程调试协议架构，类似于 [Puppeteer](https://pptr.dev/) 的无头 Node.js API，但面向端到端测试。Playwright 通过 Electron 支持 [Chrome DevTools 协议](https://chromedevtools.github.io/devtools-protocol/)（CDP）获得实验性的 Electron 支持。

### 安装依赖项

您可以通过 Node.js 包管理器安装 Playwright。It comes with its own [test runner](https://playwright.dev/docs/test-intro), which is built for end-to-end testing:

- npm

```bash
npm install --save-dev @playwright/test
```

- Yarn

```bash
yarn add --dev @playwright/test
```

::: 依赖注意事项

This tutorial was written with `@playwright/test@1.52.0`. Check out [Playwright's releases](https://github.com/microsoft/playwright/releases) page to learn about changes that might affect the code below.

:::

### 编写测试

Playwright 通过 `_electron.launch` API 在开发模式下启动您的应用程序。要将此 API 指向 Electron 应用，可以将路径传递到主进程入口点（此处为 `main.js`）。

```js
import { test, _electron as electron } from '@playwright/test'

test('launch app', async () => {

  const electronApp = await electron.launch({ args: ['.'] })

  // close app

  await electronApp.close()

})
```

After that, you will have access to an instance of Playwright's `ElectronApp` class. 这是一个功能强大的类，可以访问主进程模块，例如：

```js
import { test, _electron as electron } from '@playwright/test'

test('get isPackaged', async () => {

  const electronApp = await electron.launch({ args: ['.'] })

  const isPackaged = await electronApp.evaluate(async ({ app }) => {

    // 在 Electron 的主进程运行，这里的参数总是

    // 主程序代码中 require('electron') 的返回结果。

    return app.isPackaged

  })

  console.log(isPackaged) // false（因为我们处在开发环境）

  // 关闭应用程序

  await electronApp.close()

})
```

It can also create individual [Page](https://playwright.dev/docs/api/class-page) objects from Electron BrowserWindow instances. 例如，获取第一个 BrowserWindow 并保存一个屏幕截图：

```js
import { test, _electron as electron } from '@playwright/test'

test('save screenshot', async () => {

  const electronApp = await electron.launch({ args: ['.'] })

  const window = await electronApp.firstWindow()

  await window.screenshot({ path: 'intro.png' })

  // close app

  await electronApp.close()

})
```

Putting all this together using the Playwright test-runner, let's create an `example.spec.js` test file with a single test and assertion:

`example.spec.js`

```js
import { test, expect, _electron as electron } from '@playwright/test'

test('example test', async () => {

  const electronApp = await electron.launch({ args: ['.'] })

  const isPackaged = await electronApp.evaluate(async ({ app }) => {

    // 在 Electron 的主进程运行，这里的参数总是

    // 主程序代码中 require('electron') 的返回结果。

    return app.isPackaged

  })

  expect(isPackaged).toBe(false)

  // Wait for the first BrowserWindow to open

  // and return its Page object

  const window = await electronApp.firstWindow()

  await window.screenshot({ path: 'intro.png' })

  // close app

  await electronApp.close()

})
```

然后，使用 `npx playwright test` 运行 Playwright 测试。您应该在您的控制台中看到测试通过，并在您的文件系统上看到一个屏幕截图 `intro.png`。

```text
☁ $ npx playwright test

Running 1 test using 1 worker

 ✓ example.spec.js:4:1 › example test (1s)
```

info

PlayWright Test 将自动运行与正则表达式 `.*(test|spec)\.(js|ts|mjs)` 匹配的所有文件。You can customize this match in the [Playwright Test configuration options](https://playwright.dev/docs/test-configuration). It also works with TypeScript out of the box.

延伸阅读

Check out Playwright's documentation for the full [Electron](https://playwright.dev/docs/api/class-electron) and [ElectronApplication](https://playwright.dev/docs/api/class-electronapplication) class APIs.

## 使用自定义测试驱动

当然，也可以使用 node 的内建 IPC STDIO 来编写自己的自定义驱动。自定义测试驱动程序需要您写额外的应用代码，但是有较低的开销，让您在您的测试套装上显示自定义方法。

我们将用 Node.js 的 [`child_process`](https://nodejs.org/api/child_process.html) API 来创建一个自定义驱动。测试套件将生成 Electron 子进程，然后建立一个简单的消息传递协议。

`testDriver.js`

```js
const electronPath = require('electron')

const childProcess = require('node:child_process')

// spawn the process

const env = { /* ... */ }

const stdio = ['inherit', 'inherit', 'inherit', 'ipc']

const appProcess = childProcess.spawn(electronPath, ['./app'], { stdio, env })

// listen for IPC messages from the app

appProcess.on('message', (msg) => {

  // ...

})

// 向应用发送IPC消息

appProcess.send({ my: 'message' })
```

在 Electron 应用程序中，您可以使用 Node.js 的 [`process`](https://nodejs.org/api/process.html) API 监听消息并发送回复：

`main.js`

```js
// 监听测试套件发送过来的消息

process.on('message', (msg) => {

  // ...

})

// 发送一条消息到测试套件

process.send({ my: 'message' })
```

现在，我们可以使用 `appProcess` 对象从测试套件到 Electron 应用进行通讯。

为方便起见，您可能希望将 `appProcess` 包装在一个提供更高级功能的驱动程序对象中。下面是一个示例。让我们从创建一个 `TestDriver` 类开始：

`testDriver.js`

```js
class TestDriver {

  constructor ({ path, args, env }) {

    this.rpcCalls = []

    // 启动子进程

 env.APP_TEST_DRIVER = 1 // 让应用知道它应当侦听信息

    this.process = childProcess.spawn(path, args, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env })

    // 处理RPC回复

    this.process.on('message', (message) => {

      // 弹出处理器

      const rpcCall = this.rpcCalls[message.msgId]

      if (!rpcCall) return

      this.rpcCalls[message.msgId] = null

      // 拒绝/接受（reject/resolve）

      if (message.reject) rpcCall.reject(message.reject)

      else rpcCall.resolve(message.resolve)

    })

    // 等待准备完毕

    this.isReady = this.rpc('isReady').catch((err) => {

      console.error('Application failed to start', err)

      this.stop()

 process.exit(1)

    })

  }

  // 简单 RPC 回调

  // 可以使用：driver.rpc('method', 1, 2, 3).then(...)

  async rpc (cmd, ...args) {

    // send rpc request

    const msgId = this.rpcCalls.length

    this.process.send({ msgId, cmd, args })

    return new Promise((resolve, reject) => this.rpcCalls.push({ resolve, reject }))

  }

  stop () {

    this.process.kill()

  }

}

module.exports = { TestDriver }
```

In your app code, you can then write a simple handler to receive RPC calls:

`main.js`

```js
const METHODS = {

  isReady () {

    // 进行任何需要的初始化

    return true

  }

  // 在这里定义可做 RPC 调用的方法

}

const onMessage = async ({ msgId, cmd, args }) => {

  let method = METHODS[cmd]

  if (!method) method = () => new Error('Invalid method: ' + cmd)

  try {

    const resolve = await method(...args)

 process.send({ msgId, resolve })

  } catch (err) {

    const reject = {

      message: err.message,

      stack: err.stack,

      name: err.name

    }

 process.send({ msgId, reject })

  }

}

if (process.env.APP_TEST_DRIVER) {

 process.on('message', onMessage)

}
```

然后，在您的测试套件中，您可以使用 `TestDriver` 类用你选择的自动化测试框架。下面的示例使用 [`ava`](https://github.com/avajs/ava)，但其他流行的选择，如 Jest 或者 Mocha 也可以：

`test.js`

```js
const electronPath = require('electron')

const test = require('ava')

const { TestDriver } = require('./testDriver')

const app = new TestDriver({

  path: electronPath,

  args: ['./app'],

  env: {

    NODE_ENV: 'test'

  }

})

test.before(async t => {

  await app.isReady

})

test.after.always('cleanup', async t => {

  await app.stop()

})
```
