// Manda los recordatorios por WhatsApp que tocan ahora.
// Lo llama el cron de Vercel (vercel.json) o un cron externo con ?key=CRON_SECRET.
import { wrap, send, getQuery, getConfig } from './_lib/core.js';
import { checkCron, runReminders } from './_lib/reminders.js';

export default wrap(async (req, res) => {
  checkCron(req, getQuery(req));
  const cfg = await getConfig();
  const run = await runReminders(cfg, req, { source: 'cron' });
  return send(res, 200, run);
});
