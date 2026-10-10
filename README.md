# dsh-voice-push-to-talk

给 DSH Web GUI 的**按键说话**（push-to-talk）：在输入框里**长按空格**开始录音，**松开**自动停止并转写，文字落入草稿。

短按空格（< 220 ms）仍然是**普通空格**，所以日常打字不受影响。

## 兼容性

**目标版本：DSH Desktop `0.2.0-rc.2`**（本插件即在该版本上开发和验证；对应 Electron 44、Node 24.18.1）。`package.json` 里以 `engines.dsh` 声明了这一版本。

它依赖该版本的以下接口。DSH 将来若改动这些名字，插件可能失效：

| 接口 | 用途 |
|---|---|
| 槽位 `conversation.input.right` | 挂载状态控件；`kind: "list"`，注册必须带 `id` |
| 语音 Remote `remote.speech` | 转写服务，由 `@deepseek-ai/dsh-experimental-voice-input-bundle` 提供 |
| 会话绑定属性 `inputActions`（`uiSession.current`） | 把转写文字插入草稿 |
| Cordis 注入语义 | 读取点号服务名必须来自注入过它的上下文 |

**怎么查看你那台机器的版本**：插件页里官方 Bundle 后面标的版本号就是你的 DSH 版本。如果 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` 都显示 `0.2.0-rc.2`，就与本插件验证过的版本一致。

**版本不一致时会怎样**：不会导致 DSH 起不来。插件拿不到所需接口时，只在输入框旁显示一行原因，或在控件未能挂载时于左下角给出红条提示；随时可以在插件页禁用它。

## 依赖与启动安全

功能上复用已启用的语音输入 Bundle：转写走 `remote.speech`，草稿插入走会话绑定的 `inputActions`。所以要先启用 `@deepseek-ai/dsh-experimental-voice-input-bundle` 并备好模型。

**草稿句柄不依赖任何槽位挂载。** 按优先级两级解析：

1. 输入区槽位组件挂载后通过 props 提供的 `inputActions`；
2. **会话绑定** `ctx.get("uiSession").current.getSnapshot().props.inputActions`——`current` 是主视图当前显示的会话，这条路径不需要任何组件渲染。

第 2 条是主要通道：即使槽位因布局变化没有挂载，长按空格与转写插入依然可用（此时只是没有界面指示）。槽位贡献仅用于显示状态小点与提示。

**激活路径刻意不含任何跨插件依赖。** Web 启动审计把任何没有到达 `active` 的条目都判为启动失败（`web boot: N entry did not activate`），因此：

- 激活只依赖核心服务 `slots` / `locale`。语音 Remote 通过 `ctx.inject(["remote", "remote.speech"], cb)` 获取——Cordis 的 `inject()` 会**新建一个子 fiber**，而启动审计只看 Loader 条目；所以即使语音 Bundle 被禁用、子 fiber 一直等待，本条目照样 active，不会拖垮启动。**这个子 fiber 因此绝不能被 await。**
- 子 fiber 的回调只保存上下文、不读取任何服务属性（读取点号服务名未注入会抛 `cannot get property ... without inject`）；`.speech` 在每次使用时惰性读取并带兜底。两个服务名都必须注入：只注入 `remote.speech` 时读 `.remote` 仍会抛错。
- 注册控件失败会被捕获并降级，绝不向上抛。
- 挂载点是 `conversation.input.right`（`kind: "list"`，且**必须带 `id`**，否则注册被静默拒绝），**不是** `conversation.input.activity`——后者是 `kind: "single"`，只能有一个占位者，抢它会把官方语音插件挤成 failed，进而导致整个 Web 启动失败。

## 安装

插件管理页 →**添加插件**→ 填入本目录的绝对路径 → 安装 →**立即启用**。若图标/行为未出现，刷新一次页面。

包同时声明了两半，缺一不可：

- `dsh.bundle`（指向 [cordis.patch.yml](cordis.patch.yml)）——只有声明了组合包补丁，插件管理器才会把它当作可安装的插件；补丁只**插入自己的一行**，不替换任何官方组件。
- `dsh.client`（`platform: web`）——浏览器半侧，由客户端模块系统按需加载。

按顺序点「安装」→「立即启用」：安装只是把包装进 profile，启用才会把补丁行挂上。

## 行为

| 操作 | 结果 |
|---|---|
| 长按空格 ≥ 220 ms | 打开麦克风，输入框旁显示录音状态与实时电平 |
| 松开空格 | 停止录音 → 转写 → 插入草稿 |
| 短按空格 | 插入一个空格 |
| 录音中按 Esc / 切走窗口 / 页面隐藏 | 丢弃录音，不转写 |
| 麦克风授权弹窗期间按 Esc | 静默取消，**不**报错 |
| 在输入框之外按空格 | 完全不拦截 |
| 中文输入法候选状态下按空格 | 不拦截，交给输入法 |
| 待命时 | 输入框右侧控件行显示一个**空心小点**，表示插件已挂载并待命 |
| 长按未被接管时 | 该位置显示琥珀色提示，如「长按不可用：焦点不在输入框」，5 秒后消失 |

录音按 Host 要求编码为 **16 kHz 单声道 PCM16 WAV**（44 字节标准头），并遵守 Host 目录里的 `maxDurationSeconds` / `maxAudioBytes` 上限，到时自动停止。

## 已知边界

- 录到空音频、转写失败、草稿在录音期间被改动时，会在输入框旁显示一行红字提示，6 秒后消失；失败时**不会**插入半截文字，**下一次长按会立刻清除提示并重试**。
- 语音 Bundle 未启用时会提示「语音服务未启用：请先在插件页启用语音输入 Bundle」，此时不录音。
- 转写结果需要你确认后再发送，不会自动发送。
- "本地识别"指运行 DSH 的那台机器。
- 空格归属：长按被本插件接管后，**无法再用长按空格连续输入空格**；连续空格请用短按或粘贴。
- 空格只在**输入框所在的编辑器子树内**被接管。侧栏等其它编辑器即使与应用外壳共享祖先，也不会触发录音。
- 诊断三重可见，便于定位"没反应"：待命小点（控件已挂载）、控件内的琥珀提示（长按未被接管及原因）、以及控件 5 秒内始终未挂载时页面左下角的红条。控制台同一原因最多 `warn` 三次（warn 级别，默认过滤可见）。

## 日志

浏览器插件写不了文件，而控制台不是谁都能看。所以插件把轨迹写进 **Local Storage**（键 `dsh-voice-push-to-talk.trace`）——Chromium 把它落在应用数据目录的 LevelDB 里，因此这条日志**会真正落盘**，事后可以直接读，不需要用户提供任何输出。

记录的事件：`activate` / `listeners-attached` / `slot-declared` / `slot-registered` / `slot-register-failed` / `armed`（附带句柄来源与 `uiSession` 是否可用）/ `watchdog` / 前 8 次 `space` 的现场（焦点元素、锚点、作用域、句柄、锁定）/ `stall`（含原因与现场）/ `record-start` / `record-stop` / `transcribe` / `insert` / `fail`。环形缓冲保留最近 80 条，内容为纯 ASCII（非 ASCII 转义），便于在原始存储中检索。

读取：

```bash
node ../verify/read-trace.js
```

Chromium 对 Local Storage 的刷盘有延迟，操作后约 10 秒再读最稳妥。

## 测试

`../verify/` 下五个脚本（用打包自带的 Node 运行，`verify/` 内以 `process.argv[2]` 可覆盖包路径）：

- `manifest-verify.js`：复刻**安装器**的 `dsh.bundle` 接受规则（含"缺声明即拒"的复现）与 app-boot 的 patch 解析，并用 Host 自带的 js-yaml 解析补丁；再用 Host 的 `parseDshClient`/`clientExportOf` 校验客户端声明。含 6 项反向控制。
- `slots-verify.js`：从 app.asar 读出真实槽位声明表，断言本插件只注册进 `list` 槽位、且该注册带 `id`（缺 `id` 会被拒绝，正是控件一直没挂载的原因）；并以 `conversation.input.activity`（`single`）作为崩溃回归对照。
- `ptt-verify.js`：桩环境驱动引擎，覆盖短按/长按/输入法/焦点范围/取消/语音服务缺失降级/仅靠会话绑定插入，以及落盘轨迹内容，共 50 项；DOM 使用带真实 `contains`/`querySelector` 语义的嵌套结构。
- `wav-verify.js`：从**已安装的 app.asar** 里取出 Host 自己的 `validateWave`，验证本插件的 WAV 编码器被接受（并反向验证校验器确实会拒绝坏头）。
- `read-trace.js`：读取插件落盘的轨迹日志（见上文「日志」）。
