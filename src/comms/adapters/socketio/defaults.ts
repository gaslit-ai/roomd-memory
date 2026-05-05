export interface SocketIoEventNames {
  readonly send: string
  readonly recv: string
  readonly message: string
}

export const DEFAULT_SOCKETIO_EVENT_NAMES: SocketIoEventNames = Object.freeze({
  send: 'send',
  recv: 'recv',
  message: 'message',
})

export const DEFAULT_SOCKETIO_NAMESPACE = '/comms'
