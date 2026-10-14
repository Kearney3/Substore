import { CronExpressionParser } from 'cron-parser';

export const MIN_INTERVAL = 5 * 60 * 1000;
export function nextCron(cron: string, now = Date.now(), timezone = 'UTC'): number {
  if (!cron || cron.length > 128) throw new Error('Invalid cron expression');
  const schedule = CronExpressionParser.parse(cron, { currentDate: now, tz: timezone });
  const next = schedule.next().getTime();
  let previous = next;
  for (let i = 0; i < 20; i++) {
    const time = schedule.next().getTime();
    if (time - previous < MIN_INTERVAL) throw new Error('Free-plan schedules must be at least 5 minutes apart');
    previous = time;
  }
  return next;
}

export function redact(message: string, secrets: string[] = []): string {
  let result = message
    .replace(/\b(?:https?|ss|ssr|trojan|vmess|vless|hysteria2?|tuic|anytls):\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/("?(?:password|token|gistToken|secret|authorization|age-secret-key)"?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}\]]+)/gi, '$1[redacted]');
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]');
  return result.slice(0, 2000);
}
