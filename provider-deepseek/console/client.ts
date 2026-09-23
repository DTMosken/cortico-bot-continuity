import type { ConsoleClientBundle } from 'cortico/web/shared/client-panel.ts';
import compat from 'cortico/providers/openai-responses-compat/console/client.ts';
import { schedulePanel } from './schedule-panel.ts';

export default {
  ...compat,
  panels: { ...compat.panels, schedule: schedulePanel },
} satisfies ConsoleClientBundle;
