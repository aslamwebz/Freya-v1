/**
 * Public surface of the control plane module.
 *
 * The main process calls `startControl` once during boot, after Core is up
 * (or at least after the dependencies are wired). The returned handle is the
 * single owner of the named pipe / Unix socket; it stops on app quit, and
 * nothing else may bind the same channel.
 */

export { startControlServer as startControl, type ControlServer as ControlHandle } from './server'
export { ControlService } from './service'
export {
  PROTOCOL_VERSION,
  ALL_METHODS,
  READ_METHODS,
  ACTION_METHODS,
  WAIT_METHODS,
  type ControlRequest,
  type ControlResponse,
  type ControlError,
  type ControlEvent,
  type CallerIdentity,
} from './contract'
