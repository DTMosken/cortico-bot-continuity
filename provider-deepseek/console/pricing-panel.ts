import type { ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { pricingEditor } from 'cortico/web/client/console-pages/builtins/llm-settings/pricing-panel.ts';
import { currentPricingBand, type DeepSeekPricingSchedule } from '../pricing.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';

interface PricingState {
  name: string;
  schedule: DeepSeekPricingSchedule;
  band: 'peak' | 'offPeak';
  official: PriceDefinition;
  custom: unknown[];
  editing: boolean;
}

interface PricingInstance { name: string }

export const pricingPanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const zh = ctx.language === 'zh';
    const S = zh ? {
      title: 'DeepSeek 官方价目', current: '当前计价档位', peak: '高峰', offPeak: '空闲', model: '模型',
      meter: '用量', cached: '输入（缓存命中）', uncached: '输入（缓存未命中）', output: '输出',
      custom: '端点自定义报价', customOn: '已设置覆盖', fallback: '未设置，使用模块价目',
      save: '应用报价', saved: '报价已写入连接草稿；保存连接后生效', savedNow: '报价已保存',
      choose: 'DeepSeek 端点',
      loadError: '无法读取价目', noInstances: '没有可用的 DeepSeek 端点',
    } : {
      title: 'DeepSeek official rates', current: 'Active pricing band', peak: 'Peak', offPeak: 'Off-peak', model: 'Model',
      meter: 'Usage', cached: 'Input (cache hit)', uncached: 'Input (cache miss)', output: 'Output',
      custom: 'Endpoint-specific quote', customOn: 'Override configured', fallback: 'Unset; using module rates',
      save: 'Apply quote', saved: 'Quote staged; save the connection to apply it', savedNow: 'Quote saved',
      choose: 'DeepSeek endpoint',
      loadError: 'Unable to load rates', noInstances: 'No DeepSeek endpoints are available',
    };
    const message = ctx.ui.msgline();
    const selector = ctx.scope.instance ? null : ctx.ui.select({
      options: [],
      onChange: (name) => void load(name),
    });
    if (selector) ctx.root.append(ctx.ui.field(S.choose, selector));
    const content = ctx.ui.h('div');
    ctx.root.append(content, message);

    let endpointNames: string[] = [];
    if (ctx.scope.instance) {
      endpointNames = [ctx.scope.instance];
    } else {
      try {
        const instances = await ctx.invoke<PricingInstance[]>('instances');
        endpointNames = instances.map(({ name }) => name);
      } catch (error) {
        message.textContent = `${S.loadError}: ${String(error)}`;
        return;
      }
      if (!endpointNames.length) {
        message.textContent = S.noInstances;
        return;
      }
      selector!.replaceChildren(...endpointNames.map((name) => {
        const option = ctx.ui.h('option', null, name) as HTMLOptionElement;
        option.value = name;
        return option;
      }));
    }
    if (ctx.signal.aborted) return;
    await load(endpointNames[0]);

    async function load(name: string): Promise<void> {
      try {
        const state = await ctx.invoke<PricingState>('state', [{ name }]);
        if (ctx.signal.aborted) return;
        render(state);
        message.textContent = '';
      } catch (error) {
        message.textContent = `${S.loadError}: ${String(error)}`;
      }
    }

    function render(state: PricingState): void {
      const card = ctx.ui.sheet({ title: S.title });
      const band = currentPricingBand(state.schedule, new Date());
      card.body.append(ctx.ui.statgrid([
        { k: S.model, v: state.official.models.join(', ') },
        { k: S.current, v: band === 'peak' ? S.peak : S.offPeak, accent: true },
      ]));
      const table = ctx.ui.table({ head: [S.meter, S.peak, S.offPeak] });
      const peakRules = state.official.timeWindows?.[0]?.rules ?? [];
      const labels = new Map([
        ['cachedInput', S.cached], ['uncachedInput', S.uncached], ['output', S.output],
      ]);
      for (const rule of state.official.rules) {
        const peak = peakRules.find((item) => item.meter === rule.meter)?.perMillion ?? rule.perMillion;
        const format = (rate: number) => `¥${rate.toFixed(2)} / 1M`;
        table.addRow([
          labels.get(rule.meter) ?? rule.meter,
          band === 'peak' ? ctx.ui.chip(format(peak), 'accent') : format(peak),
          band === 'offPeak' ? ctx.ui.chip(format(rule.perMillion), 'accent') : format(rule.perMillion),
        ]);
      }
      card.body.append(table.el, ctx.ui.msgline(`${state.official.source} · Asia/Shanghai`));

      const details = ctx.ui.h('details', 'deepseek-custom-pricing');
      const summary = ctx.ui.h('summary', null, S.custom);
      const badge = ctx.ui.pill(state.custom.length ? S.customOn : S.fallback, state.custom.length ? 'on' : 'plain');
      summary.append(' ', badge);
      details.append(summary);
      let customPricing = state.custom;
      const editor = pricingEditor(ctx.ui, state.custom, [], (value) => { customPricing = value; }, ctx.language);
      details.append(editor.body);
      const save = ctx.ui.button(S.save, { variant: 'primary', onClick: () => void savePricing() });
      details.append(ctx.ui.actions().appendChild(save));
      content.replaceChildren(card.el);

      async function savePricing(): Promise<void> {
        if (!editor.validate()) return;
        const release = ctx.ui.disable(save);
        try {
          const updated = await ctx.invoke<PricingState>('save', [{ name: state.name, pricing: customPricing }]);
          message.textContent = updated.editing ? S.saved : S.savedNow;
          render(updated);
        } catch (error) {
          message.textContent = String(error);
        } finally {
          release.dispose();
        }
      }
    }
  },
};
