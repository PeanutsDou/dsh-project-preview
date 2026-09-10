# dsh-project-preview

DeepSeek Harness 会话内的 **「前端预览」页签**：把正在开发的项目界面挂到与「对话 / 轨迹」平行的地方，
并且**让 AI 自己挂载和刷新**，不用在浏览器和编辑器之间切来切去。

```
[对话] [轨迹] [前端预览]
                    └─ iframe → 你的 dev server
```

## 为什么用它

开发带界面的东西时，最常见的摩擦是「改完了得自己开浏览器、切窗口、按刷新」。
这个插件把这个动作收进会话里，并且**把控制权交给 AI**：

- AI 做完一次改动 → 调 `project_preview(action="refresh")` → 页签自己重新加载；
- AI 起了个新项目 → 调 `project_preview(action="show", url=...)` → 页签自己出现；
- 然后 AI 告诉你「切到「前端预览」页签看」。

## 会话隔离

预览状态**按会话存**。你在哪个会话里挂的，就只有那个会话的页签看得到——
因为每个会话开发的项目本来就不一样。

## 安装

要求 DSH Web 版。在 profile 目录（如 `~/.dsh/profiles/web`）：

```bash
npm install @peanutsdou/dsh-project-preview
```

然后在 `cordis.patch.yml` 挂载：

```yaml
- insert:
    - id: dsh-project-preview
      name: '@peanutsdou/dsh-project-preview'
      config: {}
```

重启 `dsh web` 生效（DSH 只在进程启动时加载插件）。

## AI 工具

`project_preview`：

| action | 作用 |
|---|---|
| `show` | 挂载地址。`url` 必填（http/https），`title` 可选 |
| `refresh` | 让当前地址重新加载 |
| `status` | 查询当前挂的是什么 |
| `clear` | 清空 |

## 它不做什么

刻意做小：

- **不托管文件** —— 预览的就是你自己的 dev server，插件只负责显示它；
- **不起进程** —— 不猜项目类型、不自动跑 `npm run dev`；
- **不读工作区** —— host 半只 inject `webServer` 和 `tools` 两个服务。

## 已知限制

- **Electron 之类的桌面应用不能内嵌**，会显示提示 + 「在外部打开」按钮；
- 少数 dev server 会设 `X-Frame-Options` / `frame-ancestors` 禁止被嵌入，同样走降级提示；
- 单实例：一个会话一个预览页签。

## 开发

```bash
pnpm install
pnpm run build      # tsc（host + 类型）→ tsdown（client 单文件 bundle）
```

**客户端必须是单文件 CJS**：DSH 前端用 `window.__ModuleLoader__.load` 包装它，
浏览器运行时解析不了 `require('./其他文件')`。`tsdown.config.ts` 里的
banner/intro/footer 三段拼出这个外壳，不要改。

## License

MIT
