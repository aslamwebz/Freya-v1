import { randomUUID } from 'node:crypto';
import type { RemoteCommand, RemoteCommandResult, DeviceId } from './types.js';

export class InMemoryRemoteCommandEngine {
  private commands = new Map<string, RemoteCommand>();
  private results = new Map<string, RemoteCommandResult>();

  issue(command: RemoteCommand): RemoteCommandResult {
    this.commands.set(command.id, command);
    const result: RemoteCommandResult = {
      commandId: command.id,
      success: true,
      result: { kind: command.kind, payload: command.payload },
      error: null,
      executedAt: Date.now(),
      executedBy: command.targetDeviceId,
    };
    this.results.set(command.id, result);
    return result;
  }

  execute(commandId: string): RemoteCommandResult {
    const existing = this.results.get(commandId);
    if (!existing) throw new Error(`Command ${commandId} not found`);
    return existing;
  }

  get(commandId: string): RemoteCommandResult | null {
    return this.results.get(commandId) || null;
  }

  list(deviceId: DeviceId): RemoteCommandResult[] {
    return Array.from(this.results.values()).filter(r => r.executedBy === deviceId);
  }
}
