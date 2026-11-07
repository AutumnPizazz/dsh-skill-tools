# dsh-skill-tools

为 dsh 的内置及自定义预设提供 `skill_search` 和 `skill_load`：按需检索技能、加载正文。项目通过 [GitHub](https://github.com/AutumnPizazz/dsh-skill-tools) 分发，运行时零依赖，采用 MIT 许可证。

## 安装

要求 Node.js >=24.9.0；支持的框架版本为 dsh 0.2.2-rc.1。

在选定目录克隆仓库：

```bash
git clone https://github.com/AutumnPizazz/dsh-skill-tools.git
```

进入仓库根目录执行安装，以下以用户级 profile `~/.dsh` 为例：

```bash
npm install --prefix "$HOME/.dsh" --omit=dev "$PWD"
```

本地目录安装使用符号链接，安装后保留源码目录。

在当前 dsh profile 的 `cordis.patch.yml` 中追加：

```yaml
- insert:
    - id: skill-tools
      name: dsh-skill-tools
      config: {}
```

在宿主根上下文挂载一次。每个工具名保持唯一；若其他插件注册了同名工具，先停用对应条目。切换配置前关闭 dsh，保存后重新启动。

## 预设与生命周期

| 预设 | 技能工具入口 |
|---|---|
| `standard`、`cordis` | 在 agent 作用域注册两个工具，替换继承的 `skill` |
| `minimal` | 提供 `skill_search`、`skill_load` |
| `ptc` | 外层入口为 `run_code`，通过 SDK 的 `tools.skill_search(...)`、`tools.skill_load(...)` 调用 |
| 自定义预设 | 默认启用，可用 `presets` 配置限定范围 |

已有和新建 agent 均适用。agents 服务就绪后自动挂载；agent 销毁或插件卸载时撤销本插件贡献，恢复原工具。同层工具冲突会报错并回滚。

独立 Context 可使用根层工具；agent 级替换依赖 agents 服务。工具调用沿用 dsh 的权限、guard 和执行器管线。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `skill_search` | 可选 `query` | 空查询列目录；关键词查询按相关度返回名称与描述，低置信结果单独标注 |
| `skill_load` | `name` | 按精确名、忽略大小写、唯一部分匹配的顺序查找；歧义时列出候选；正文按上限截断 |

文件技能加载时剥离 frontmatter。加载结果包含目录、URL 或 opaque 资源基址，相对资源按该基址解析。检索采用中文 bigram、英文轻词干、IDF 与覆盖率筛选。

## 技能来源

`catalogSource: auto` 合并 dsh 原生 skills registry 与文件目录，原生同名条目优先。支持项目、用户、运行时及自定义 provider 提供的技能。

registry 查询使用调用 agent 的 scope、工作目录和取消信号。原生条目的调用策略优先于目录配置，加载时重新读取并校验。空查询只列元数据；关键词查询在启用正文索引时读取正文。

每次工具调用重新查询技能。原生 registry 的内部缓存与失效策略由 dsh 管理。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `dirs` | `['~/.dsh/skills']` | 非空目录数组，按顺序去重；用于文件目录查询 |
| `catalogSource` | `'auto'` | `auto` 合并来源；`filesystem` 读取目录；`registry` 要求 skills 服务 |
| `presets` | `[]` | 空数组表示全部；显式列表限定预设；预设不可判定时启用 |
| `replaceTools` | `['skill']` | 需要替换的技能工具名，自定义别名按需添加 |
| `searchToolName` | `'skill_search'` | 搜索工具名 |
| `loadToolName` | `'skill_load'` | 加载工具名 |
| `includeUserOnly` | `false` | 文件目录是否包含 disable-model-invocation 条目；原生调用策略优先 |
| `maxResults` | `8` | 搜索结果数 |
| `maxBodyChars` | `60000` | 加载正文字符上限 |
| `bodyIndexChars` | `2000` | 每篇正文参与索引的字符数；0 表示关闭正文索引 |
| `minCoverage` | `0.5` | 常规命中覆盖率 |
| `scoreRatio` | `0.3` | 相对最高分阈值 |
| `approxMinCoverage` | `0.25` | 近似结果覆盖率 |

工具名须互异，并避开保留名 `run_code`。配置错误在启动时报告。

## 离线 CLI

在仓库根目录运行，查询指定文件目录：

```bash
node cli.mjs --list --dir ./skills
node cli.mjs --search '生成拓扑图' --dir ./skills --json
```

也可使用 `node index.mjs ...`。包入口导出纯函数 `discoverSkills`、`buildIndex`、`searchSkills`。

## 开发与打包

```bash
npm ci --ignore-scripts
npm test
npm run test:ptc
npm pack --dry-run
```

`DSH_SKILL_TEST_DIR=/path/to/skills npm test` 额外验证 46 条真实技能查询。PTC 进程集成需要可用的本地 sandbox 后端。测试范围与结果见 [验证记录](docs/verification.md)。

`npm pack` 的本地 tgz 归档包含六个运行模块、README、LICENSE 和 package.json。GitHub 仓库另含测试和开发文档。
