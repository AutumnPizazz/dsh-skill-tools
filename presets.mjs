/** 仅使用公开的 agent 生命周期和 scoped tools 接口，不修改预设定义或源码。 */
export function serviceOf(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
}

export function presetOf(ctx, agent) {
  if (!agent) return undefined;
  try {
    const presets = serviceOf(ctx, 'agentPresets');
    const composed = agent.ctx && presets?.composedPreset?.(agent.ctx);
    if (composed) return String(composed);
    if (agent.session === undefined) return undefined;
    const selected = presets?.presetForSession?.(agent.session);
    if (selected) return String(selected);
    const registry = serviceOf(ctx, 'sessionProjections');
    const value = registry?.snapshot?.(agent.session, ['agentPreset'])?.values?.agentPreset
      ?? registry?.stateOf?.(agent.session, 'agentPreset');
    return value === undefined || value === null || value === '' ? undefined : String(value);
  } catch {
    return undefined;
  }
}

export function presetEnabled(ctx, agent, config) {
  const preset = presetOf(ctx, agent);
  return config.presets.length === 0 || preset === undefined || config.presets.includes(preset);
}

/** 双重生命周期所有权：agent 释放或插件卸载，都会撤销本插件的 scoped 贡献。 */
function bindAgents(ctx, definitions, config) {
  const agents = serviceOf(ctx, 'agents');
  const tools = serviceOf(ctx, 'tools');
  if (!agents) return;
  const bindings = new Map();
  const detach = (agent) => {
    const cleanup = bindings.get(agent);
    bindings.delete(agent);
    cleanup?.();
  };
  const refresh = (agent) => {
    detach(agent);
    if (!presetEnabled(ctx, agent, config)) return;
    const disposers = [];
    const undo = () => { for (const fn of disposers.splice(0).reverse()) fn(); };
    try {
      // 正常 scoped 注册，其他工具的 allow/deny、guard、执行器和授权管线不改动。
      for (const definition of definitions) {
        disposers.push(serviceOf(agent.ctx, 'tools').register(definition, config.presets.length
          ? { when: ({ agent: current }) => presetEnabled(ctx, current, config) } : {}));
      }
      const view = tools.view(agent);
      const deny = config.replaceTools.filter(name => tools.get(name, agent) !== undefined);
      for (const name of deny) {
        if (!view.restrictableNames.has(name)) {
          throw new Error(`dsh-skill-tools: cannot replace same-layer tool "${name}"; mount the plugin at the host root`);
        }
      }
      if (deny.length) disposers.push(serviceOf(agent.ctx, 'tools').restrict({ deny }));
      bindings.set(agent, undo);
    } catch (error) {
      undo();
      throw error;
    }
  };
  ctx.effect(() => () => { for (const agent of [...bindings.keys()]) detach(agent); });
  ctx.on('agent/created', ({ agent }) => { refresh(agent); });
  ctx.on('agent/disposed', ({ agent }) => { detach(agent); });
  ctx.on('agent-preset/selected', (id) => {
    const agent = agents.get(id);
    if (agent) refresh(agent);
  });
  try {
    for (const agent of agents.list()) refresh(agent);
  } catch (error) {
    for (const agent of [...bindings.keys()]) detach(agent);
    throw error;
  }
}

/** 延迟依赖由 Cordis 管理，agents 服务晚于本插件启动或重载时同样生效。 */
export function installPresetTools(ctx, definitions, config) {
  if (typeof ctx.inject === 'function') {
    return ctx.inject(['agents'], scoped => bindAgents(scoped, definitions, config));
  }
  return bindAgents(ctx, definitions, config);
}
