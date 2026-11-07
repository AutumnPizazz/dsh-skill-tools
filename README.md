# dsh-skill-tools

为 dsh 的所有 agent preset 提供按需 `skill_search` / `skill_load`，用两个工具取代原生 `skill` 工具及其完整目录提示。运行时零依赖，MIT。

从 `dsh-minimal-skill` 演进；默认不再限于 minimal。通过公开插件接口工作，不修改 dsh 源码、预设定义、非技能工具、执行器或权限管线。

## 接入

要求 Node.js >=24.9.0；框架合同以 dsh 0.2.2-rc.1 为基准。npm 包发布后，安装到当前 dsh profile 可以解析的 `node_modules` 中，例如用户级 profile：

```bash
npm install --prefix "$HOME/.dsh" dsh-skill-tools
```

在该 profile 的 `cordis.patch.yml` 追加插件条目：

```yaml
- insert:
    - id: skill-tools
      name: dsh-skill-tools
      config: {}
```

只在 host 根挂载一次，不嵌入单个 agent 的工具层。移除旧 `minimal-skill` 插件条目，保留其他配置；两者不可同时注册同名工具。停止旧 dsh 后切换配置，再重启，避免编辑运行中插件触发热加载。

## 预设行为

- `standard` / `cordis`：保留其他工具，用正常 scoped 注册与限制替换继承的原生 `skill`。
- `minimal`：补齐两个技能工具。
- `ptc`：保留 `run_code` 作为唯一外层 transport；通过其 `tools.skill_search(...)` / `tools.skill_load(...)` SDK 使用两个技能工具，不改执行器或 sandbox。
- 用户自定义预设、已有和后创建的 agent：同样生效。agents 服务晚启动时由 Cordis 延迟挂载；agent 销毁或插件卸载时撤销本插件贡献并恢复原工具。

同层工具冲突会明确报错并回滚，不操作框架内部集合。没有 agents 服务的独立 Context 仍可使用根层工具，但不会替换原技能工具。

## 两个工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `skill_search` | 可选 `query` | 空查询列目录；否则按相关度给出名称和描述；低置信近似结果单独标注 |
| `skill_load` | `name` | 精确名→忽略大小写→唯一部分匹配；有歧义返回候选；正文去 frontmatter、按上限截断 |

目录/URL/opaque 资源基址随加载结果保留；相对路径以该技能的资源基址为准。中文 bigram、英文轻词干、IDF/覆盖率筛选沿用原算法，未引入向量服务或模型请求。

## 技能来源

默认 `catalogSource: auto` 合并 dsh 原生 skills registry 与目录回退，原生同名条目优先。这样保留项目、用户、运行时及自定义 provider 技能，不把标准模式降级成只读用户目录。

registry 查询带上调用 agent 的 scope、工作目录和取消信号。原生禁止模型调用的条目不能经文件回退重新暴露；加载时重新读取并校验。空查询不批量读取原生正文，有关键词且启用正文索引时读取正文参与检索。插件自身不缓存；原生 registry 的缓存和失效策略归 dsh 管理。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `dirs` | `['~/.dsh/skills']` | 非空目录数组，按顺序去重；registry 模式不扫描 |
| `catalogSource` | `'auto'` | `auto` / `filesystem` / `registry`；仅 registry 模式缺服务时报错 |
| `presets` | `[]` | 空表示全部；显式列表为白名单；preset 不可判定时放行 |
| `replaceTools` | `['skill']` | 要替换的旧技能工具名；自定义别名按需添加，不要填其他工具 |
| `searchToolName` | `'skill_search'` | 搜索工具名 |
| `loadToolName` | `'skill_load'` | 加载工具名 |
| `includeUserOnly` | `false` | 文件回退是否含 disable-model-invocation 条目；不覆盖原生调用策略 |
| `maxResults` | `8` | 搜索结果数 |
| `maxBodyChars` | `60000` | 加载正文字符上限 |
| `bodyIndexChars` | `2000` | 每个正文参与索引的字符数；0 不读正文索引 |
| `minCoverage` | `0.5` | 常规命中覆盖率 |
| `scoreRatio` | `0.3` | 相对最高分阈值 |
| `approxMinCoverage` | `0.25` | 近似结果覆盖率 |

工具名必须不同，不能使用保留名 `run_code`；配置错误启动即报错。不修改其他工具的 allow/deny 或 guard，也不绕过执行器。

## 离线 CLI

CLI 只查看指定目录，不启动 dsh 或访问 registry：

```bash
npx dsh-skill-tools --list --dir ./skills
npx dsh-skill-tools --search '生成拓扑图' --dir ./skills --json
```

也可直接运行 `node index.mjs ...`。纯函数 `discoverSkills` / `buildIndex` / `searchSkills` 从包入口导出。

## 开发与发布

```bash
npm ci --ignore-scripts
npm test
npm run test:ptc       # 额外的官方 Node PTC runtime + 本地只读 sandbox 集成
npm pack --dry-run
```

`DSH_SKILL_TEST_DIR=/path/to/skills npm test` 额外验证 46 条真实技能查询。PTC 进程集成需要可用的本地 sandbox 后端；默认测试只依赖 Node 和开发依赖，不连接模型或外部服务。

发布文件采用明确白名单：六个运行模块、README、LICENSE、package.json；不包含测试、开发依赖、工作计划、技能正文、凭据或日志。凭据仅由本机 npm 登录/用户配置提供，禁止写进仓库或对话。
