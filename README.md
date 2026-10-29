# @yueby/pi-fast-mode

为 [Pi](https://pi.dev) 提供 `/fast` 开关，向当前 provider/model 的请求 body 注入：

```json
{ "service_tier": "priority" }
```

适用于官方和自定义 provider，包括 OAuth 中转，只要其请求经过 Pi 的标准 `before_provider_request` hook。默认关闭，不按模型名称判断是否为 GPT。

## 安装

```bash
pi install npm:@yueby/pi-fast-mode
```

安装后重启 Pi，或在 Pi 中执行 `/reload`。同一时间仅启用一个注册 `/fast` 的扩展。

## 使用

先选择要使用的 provider 和模型：

```text
/fast          # 切换当前模型的开关
/fast on       # 开启当前模型
/fast off      # 关闭当前模型
/fast status   # 查看当前模型的开关与适用范围
/fast models   # 打开当前 provider 的模型范围面板
```

只有同时满足“已开启”和“在适用范围内”的模型，才会注入 `service_tier: "priority"`。关闭仅停止本扩展的注入，其他来源设置的 tier 保持原样；开启时会覆盖请求中已有的 `service_tier`。

### 模型范围面板

默认允许全部模型，包括自定义模型 ID 和别名。每个 provider 的范围独立，面板列出当前 provider 的已注册模型，并保留当前模型和已有选择。

| 按键 | 操作 |
|---|---|
| `↑` / `↓` 或 `k` / `j` | 移动光标 |
| `PageUp` / `PageDown`、`Home` / `End` | 翻页、移到首尾 |
| `Space` | 切换勾选 |
| `a` | 选择当前列表中的全部具体模型 |
| `n` | 清空范围：该 provider 下所有模型均不注入 |
| `u` | 恢复无限制：允许全部模型，包括后续新增模型 |
| `Enter` | 保存并应用 |
| `Esc` / `q` | 取消并保留原设置 |

设置范围不会自动开启 Fast。已开启的模型如果被移出范围，会暂停注入；重新纳入范围后恢复生效，`/fast status` 会说明当前状态。

### 状态显示

生效时，通过 Pi 的标准状态接口发布 `⚡ fast`。显示位置由当前 footer 决定：

- Pi 默认 footer：显示在普通扩展状态行。
- 自定义 footer：需要读取 `footerData.getExtensionStatuses()`；如果不显示扩展状态，请用 `/fast status` 检查。
- Aurora footer 可读取状态键 `pi-fast-mode`，将其布局在最底部路径／状态行右端。Aurora 的布局集成由用户自己的 footer 提供，不属于本 npm 包。

状态表示插件已启用参数注入，不代表中转或上游已确认 Priority。

## 持久化

**模型范围持久化，Fast 开关保持会话级。** 重启、新会话或 `/reload` 后会恢复过滤范围，但需要重新 `/fast on`。

默认配置：

```text
~/.pi/agent/extensions/pi-fast-mode/config.json
```

设置 `PI_CODING_AGENT_DIR` 时，配置跟随该目录，支持 `~/` 和 `~\` 展开。各项目共用用户级范围。

```json
{
  "version": 1,
  "providerScopes": {
    "my-oauth-relay": ["gpt-5.4", "custom-alias"],
    "another-relay": []
  }
}
```

- provider 没有条目：无限制。
- 非空数组：只允许精确匹配的模型 ID。
- 空数组：该 provider 下所有模型均不注入。
- 保存面板中的“无限制”：删除该 provider 的限制。

取消面板不会写盘。保存时重新读取并合并其他 provider 的条目，使用同目录事务文件和重命名替换；保存失败不会更新当前生效范围，损坏配置不会被覆盖。配置加载失败会阻止 Fast 注入，直到配置恢复可读。

其他已运行的会话在重载后读取更新。配置没有跨进程写入锁，请避免在多个 Pi 进程中同时保存模型范围。

## 兼容性与费用

- Node.js `>=22.18.0`；以 Pi `1.4.0` 接口开发并验证，需要宿主支持 `before_provider_request`。
- 模型面板需要交互式 TUI；请求参数注入本身不依赖 footer。
- 本扩展不替换 OAuth 认证、headers、baseUrl 或 provider 请求实现，不存储凭据，不发送探测请求。
- 中转必须接受并转发 `service_tier`，上游必须支持 Priority。Priority 可能额外收费，以中转和上游规则为准。
- 不调整 Pi 内部的费用倍率；不向子代理自动传递 Fast 开关。
- 自定义 provider 若绕过标准请求 hook，本扩展不能拦截它；后续 hook 也可能再次修改参数。

## 本地开发

Pi 通过 `package.json` 的 `pi.extensions` 加载 TypeScript 源码，无需构建。

```bash
pi -e ./
npm test
```

离线测试不依赖真实用户配置，文件读写仅使用测试创建的系统临时目录并在结束后清理。

真实 Pi 加载和面板测试：

```bash
PI_FAST_MODE_TEST_HOST="<Pi package directory>" \
node --test test/pi-host.integration.mjs
```

可选的用户 Aurora footer 集成测试：

```bash
PI_FAST_MODE_TEST_HOST="<Pi package directory>" \
PI_FAST_MODE_TEST_FOOTER="$HOME/.pi/agent/extensions/aurora-footer.ts" \
node --test test/aurora-footer.integration.mjs
```

这些测试不发送模型请求。本 npm 包仅包含运行时源码、README、manifest 和许可证。

## License

MIT — see [LICENSE](./LICENSE).
