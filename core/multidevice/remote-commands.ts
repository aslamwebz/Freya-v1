import type { RemoteCommand, RemoteCommandResult, DeviceId } from './types.js';
import { verifyWithDeviceKey } from './device-identity.js';
import { capabilitiesForTrust, isDeviceCapability } from './trust.js';
import type { DeviceRegistry } from './types.js';

export class InMemoryRemoteCommandEngine {
  private commands = new Map<string, RemoteCommand>();
  private results = new Map<string, RemoteCommandResult>();
  private processedNonces = new Set<string>();
  private registry: DeviceRegistry | null = null;

  setRegistry(registry: DeviceRegistry): void {
    this.registry = registry;
  }

  issue(command: RemoteCommand): RemoteCommandResult {
    if (!this.registry) throw new Error('Registry not set');

    if (this.processedNonces.has(command.nonce)) {
      return this.deny(command, 'Replay detected: nonce already used');
    }
    this.processedNonces.add(command.nonce);

    const sourceDevice = this.registry.get(command.sourceDeviceId);
    if (!sourceDevice || sourceDevice.status === 'revoked') {
      return this.deny(command, 'Source device is revoked or unknown');
    }

    const targetDevice = this.registry.get(command.targetDeviceId);
    if (!targetDevice || targetDevice.status === 'revoked') {
      return this.deny(command, 'Target device is revoked or unknown');
    }

    if (!this.registry.canIssueCommands(command.sourceDeviceId)) {
      return this.deny(command, 'Source device cannot issue commands');
    }

    if (!this.registry.canReceiveCommands(command.targetDeviceId)) {
      return this.deny(command, 'Target device cannot receive commands');
    }

    if (command.kind === 'stop-all' && sourceDevice.trust.level !== 'owner') {
      return this.deny(command, 'STOP ALL requires owner authority');
    }

    // Capability check: the source device's trust level must imply every
    // capability the command requires. Capabilities outside the closed
    // vocabulary are denied, never treated as permitted.
    const sourceCapabilities = capabilitiesForTrust(sourceDevice.trust.level);
    for (const capability of command.requiredCapabilities) {
      if (!isDeviceCapability(capability) || !sourceCapabilities.has(capability)) {
        return this.deny(command, `Source device lacks capability ${String(capability)}`);
      }
    }

    const commandData = JSON.stringify({
      id: command.id,
      kind: command.kind,
      sourceDeviceId: command.sourceDeviceId,
      targetDeviceId: command.targetDeviceId,
      payload: command.payload,
      timestamp: command.timestamp,
      nonce: command.nonce,
    });
    if (!verifyWithDeviceKey(sourceDevice.identity.publicKey, commandData, command.signature)) {
      return this.deny(command, 'Invalid source device signature');
    }

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

  private deny(command: RemoteCommand, reason: string): RemoteCommandResult {
    const result: RemoteCommandResult = {
      commandId: command.id,
      success: false,
      result: null,
      error: reason,
      executedAt: Date.now(),
      executedBy: command.targetDeviceId,
    };
    this.results.set(command.id, result);
    return result;
  }
}
