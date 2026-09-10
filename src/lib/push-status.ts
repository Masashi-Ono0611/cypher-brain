import { checkTurboUploadStatus } from './backends/turbo.js';
import { UsageError } from './errors.js';
import { printJson } from './ui.js';
import type { CliOptions } from './types.js';

export async function pushStatus(o: CliOptions): Promise<void> {
  if (!o.locator) throw new UsageError('--locator <data-item-id> required');
  const result = await checkTurboUploadStatus(o.locator);
  if (o.json) {
    printJson(result);
    return;
  }
  console.log(
    result.found ? `Turbo upload status: ${result.status}` : 'Turbo upload: not found (not found yet, or wrong id)',
  );
  console.log("This is Turbo's own self-reported status, not independent Arweave-network confirmation.");
}
