/**
 * 本地类型声明。
 *
 * 为什么需要：DSH 的客户端包（dsh-client-runtime / dsh-client-ui-slots /
 * dsh-client-ui-conversation）**不是真实安装的 npm 包**——它们是 DSH Web 前端
 * 在运行时通过 window.__ModuleLoader__ 提供的平台模块。
 * 直接 import 它们的类型，构建时会解析不到；从 npm 装又会拿到版本严重滞后的旧类型。
 *
 * 所以这里只声明**我这个插件真正用到的那一点点形状**。
 * 运行时不依赖这些声明：真正解析模块的是 DSH 自己。
 */

declare module '@deepseek-ai/dsh-tools' {
  /** dsh-tools 的工具定义包装器。只声明用到的部分。 */
  export function defineTool<T>(definition: T): T
}
