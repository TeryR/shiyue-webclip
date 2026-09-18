# 交接说明（HANDOFF）— 识玥网页剪藏 1.5.0

> 面向后续维护者/接手人。读完这份就知道:代码怎么组织、为什么这么设计、哪些是已知边界、出问题怎么回滚复核。

## 1. 交付物清单

| 文件 | 说明 |
| --- | --- |
| `main.js` | 构建产物(87KB,Obsidian 直接加载) |
| `manifest.json` | 插件清单(id: shiyue-webclip,minAppVersion 1.4.0) |
| `styles.css` | 设置页/弹窗样式 |
| `src/` | 全部 TypeScript 源码 |
| `src/test/tests.ts` | 63 项离线夹具测试 |
| `dist/shiyue-webclip-1.5.0.zip` | 发布包（main.js + manifest + styles + README） |

## 2. 架构(数据流)

```
URL 输入(剪贴板/弹窗/批量)
  → util.normalizeUrl        规范化(去追踪参数;小红书保留 xsec_token)
  → extract/index.routeUrl   按 hostname 路由
  → extract/{x,wechat,xhs,generic}   平台提取器(统一产出 ExtractResult)
  → classify(规则引擎为主,LLM 可选)→ ClassResult{category, folder, tags}
  → saver.downloadImages     图片本地化(单张失败不中断,保留原链)
  → notebuild.buildNote      frontmatter + 来源 callout + 正文 + 告警
  → saver.saveMarkdown       落盘(重名自动加后缀)
  → settings.index           去重索引(data.json,上限 3000 条)
```

关键解耦:**所有提取器只依赖 `Fetcher` 接口**(fetchText/fetchBinary/postJson),
运行时由 `fetcher.ts` 用 obsidian `requestUrl` 实现(走 Node 网络栈绕开 CORS),
测试时注入本地夹具 Fetcher,所以 63 项测试完全离线可跑。

## 3. 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 用 `@mozilla/readability` 提取通用网页 | 中文新闻正文命中率远高于手写启发式;体积可接受 |
| X 走 syndication → oembed 两级降级 | 不需要付费 API;syndication 有全文+时间+媒体,oembed 兜底正文 |
| 小红书要求用户自备 Cookie | 平台登录墙,无 Cookie 匿名抓取拿不到正文,这是平台限制不是实现缺陷 |
| 规则分类默认、LLM 可选 | 规则离线稳定零成本;LLM 任何异常都静默回退规则,不阻塞剪藏 |
| 自己实现 domToMarkdown | Obsidian MarkdownRenderer 是异步组件耦合,纯函数实现可离线测试、输出确定 |
| 抓取器自带超时/重试/限速 | 5xx/429/网络错误自动重试;批量时任务间隔+公众号额外 800ms,降低风控概率 |
| 失败就明确报错,绝不存半页垃圾 | 所有平台的"拿不到正文"路径都抛 ClipError(带用户话术),Toast 展示 + 结果面板留档 |
| 英文翻译与 LLM 强绑定(v1.1.0) | 未开 LLM/未填 Key 时零行为变化;启发式英文判定避免误翻;分块翻译(≤3800 字符 × 8 块)防输出截断;任何失败降级为保留原文+告警 |
| 重复链接三态处理(v1.2.0) | 询问(单个剪藏弹窗确认,批量自动跳过)/ 总是重新剪藏 / 总是跳过;重新剪藏只生成新笔记(文件名加序号),旧笔记永不改动;去重索引用最新一条记录做展示 |
| 剪贴板默认先确认（v1.3.0） | 侧栏图标/命令读剪贴板后先弹 ConfirmClipModal 展示链接，确认才入库——防「复制链接只想分享」被误收；可切回一键模式；只在用户主动点击入口时读一次剪贴板，无后台监听 |
| X 双通道取全文（v1.4.0） | 实测发现：长推文（note_tweet）在 syndication 只有约 280 字截断版，全文在 fxtwitter；X 长文（Article）全文只在 fxtwitter 的 article.content.blocks（draft-js）。改为双通道并行取更长正文，Article 解析 blocks 为 Markdown（含链接实体还原/标题/列表/封面） |
| 翻译失败原因透出（v1.4.0） | translateWithLlm 返回 ok/reason 联合类型，具体原因（HTTP 状态码/超时/格式）写进笔记告警；接口地址支持 base 自动补全 /chat/completions；翻译超时至少 60s |
| 头条专属提取器（v1.5.0） | 实测：桌面页 www.toutiao.com/article/{id} 是纯 JS 壳；移动页 m.toutiao.com/i{id}/ 是 SSR，含 <article> 正文与 URL-encoded articleInfo JSON（标题/发布时间/作者）。桌面链接自动转移动页；articleInfo 用「软解码」（只解码合法转义序列，避免整页 decode 因孤立 % 抛异常）+ 括号配对提取；图片下载按域名补 Referer（头条/微信/小红书防盗链） |

## 4. 验证记录(2026-08-29)

- `npm run build`：tsc 严格模式零错误 + esbuild 产出 main.js（105,080 字节）
- `node --check main.js`：语法通过（exit 0）
- `npm test`：114/114 通过（v1.4.0 的 102 项之上新增 12 项：头条路由/链接解析/移动页夹具提取/微头条拒绝）
- 真实端到端验证（test/live-toutiao.ts，真实链接）：
  - https://www.toutiao.com/article/7238487463444972084/ → 标题/作者（里溅的空瓶子）/发布时间 2023-06-23 21:33 /696 字正文/3 图，零告警
- `manifest.json`：JSON 解析通过，id/版本(1.5.0)/作者正确
- 未验证项(需要真实 Obsidian 环境):见第 6 节

## 5. 已知限制与风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 小红书风控/登录墙(无 Cookie 拿不到正文) | 平台级限制,无法绕过 | 明确报错+Cookie 引导;Cookie 过期需用户重新复制 |
| X syndication/oembed 端点变动或限流 | 推文抓取失败 | 明确报错提示手动粘贴兜底;后续可加用户自有 API Key 接入 |
| 微信「环境异常」风控 | 个别文章/网络下失败 | 明确报错;批量自动限速;浏览器验证后手动粘贴兜底 |
| JS 渲染页/付费墙正文不全 | 内容缺失 | 正文<120 字时写 warning callout;「手动粘贴内容剪藏」兜底 |
| Cookie 明文存 data.json | 本机文件泄露即 Cookie 泄露 | 设置页+README 已提示勿分享;后续可改 Obsidian CapacitorID 加密存储 |
| requestUrl 无原生取消 | 超时后底层连接可能仍在跑 | Promise 竞速已保证上层不卡死;影响仅为极少量空转流量 |
| LLM 翻译质量/长度依赖所配模型 | 长文超 8 块只译前段（笔记内告警）；译文可能有措辞瑕疵 | 原文完整保留，可对照；分块上限与告警已内置 |
| X Article 全文依赖 fxtwitter 公共代理 | 代理无 SLA，可能限流或变动 | 已实测可用（2026-08-29）；失败时明确告警并引导手动粘贴；syndication/oembed 仍是前置与后置兜底 |
| 移动端未实测 | iOS/Android 网络栈差异 | manifest isDesktopOnly=false;requestUrl 移动端可用,但严格站点表现未验证 |

## 6. 真机复核清单(接手人第一次跑插件时)

1. 装进测试仓库 → 启用 → 命令面板出现 5 条「识玥剪藏」命令
2. 复制一条微信公众号文章链接 → 「剪藏剪贴板里的链接」→ 检查笔记 frontmatter 与图片本地化
3. 复制一条 x.com 推文链接 → 同上(需本机能访问 x.com)
4. 小红书:先不配 Cookie 剪一条 → 应收到明确的 Cookie 引导弹窗(而不是存出空笔记)
5. 配 Cookie 后重试 → 正常入库
6. 随便一条普通新闻链接 → Readability 正文 + 自动分类
7. 同一链接再剪一次 → 应提示「已剪藏过 → 路径」并跳过
8. 批量 3 条混合链接 → 结果面板计数正确、公众号有额外限速
9. 启用 LLM+Key 后剪一条英文网页 → 笔记标题为中文、含「中文翻译/原文」双节;关掉 LLM 再剪则行为与原版完全一致
10. 同一链接再剪一次 → 弹窗「重新剪藏一份/跳过」;选重新剪藏 → 生成带序号新笔记且旧笔记不变;批量时同链接自动跳过
11. 复制一个链接（假设要发朋友）→ 点侧栏图标 → 应弹「确认剪藏这个链接？」；点取消 → Toast 提示未入库且仓库无新文件；点剪藏入库 → 正常入库
12. 剪 https://x.com/llama_index/status/2093012245123067989 → 应得约 750 字全文（非 300 字截断版）；剪 https://x.com/AndrewYNg/article/2093388974194872781 → 应得约 7000 字长文全文；配错 LLM Key 时笔记告警应显示具体 HTTP 状态码
13. 剪任意头条号文章链接（www.toutiao.com/article/{id}）→ 应自动走移动页拿到标题/作者/发布时间/正文；微头条链接应明确报错暂不支持

## 7. 回滚 / 卸载

- **禁用**:设置 → 第三方插件 → 关闭「识玥网页剪藏」(无后台进程、无遥测)
- **彻底回滚**:删除 `.obsidian/plugins/shiyue-webclip/` 整个文件夹即可,仓库笔记不受影响
- **版本回退**:旧版 zip 里的 main.js/manifest.json/styles.css 覆盖回去即可;插件不写任何仓库级配置,
  唯一持久状态是插件目录内 data.json(设置+去重索引),删除后重建无副作用
- 剪藏产生的笔记/图片都是普通 markdown/图片文件,任何情况下可直接编辑或删除
