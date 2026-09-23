import { DeepPartial } from 'utility-types'
import EventEmitter from 'eventemitter3'
import { IMockRequest, mockRequests } from '../mocks/mock-requests'

let mockStorage = {}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Configure an event to add more mock requests
const eventEmitter = new EventEmitter<{
  onBeforeRequest: { data: IMockRequest['webRequestBodyDetails'] }
  onBeforeSendHeaders: { data: IMockRequest['webRequestHeaderDetails'] }
  onRequestFinished: { data: IMockRequest['networkRequest'] }
}>()

// Debugger event emitter for WebSocket/SSE monitoring
type DebuggerEventCallback = (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object
) => void
const debuggerEventEmitter = new EventEmitter<{
  debuggerEvent: [chrome.debugger.Debuggee, string, object | undefined]
}>()
const debuggerEventListeners: DebuggerEventCallback[] = []

export const emitDebuggerEvent = (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object
) => {
  debuggerEventListeners.forEach((listener) => listener(source, method, params))
}

export const clearDebuggerListeners = () => {
  debuggerEventListeners.length = 0
}

// Response bodies, keyed by the protocol request id, so that a mocked
// Network.getResponseBody command can answer with the right one
const cdpResponseBodies = new Map<string, string>()

/**
 * Turn the mock requests into Chrome DevTools Protocol events.
 *
 * The panel reads network traffic over the protocol, so the mocks have to
 * speak it too.
 *
 * @returns one set of events per mock request
 */
const buildCdpEvents = () => {
  return mockRequests
    .filter((mockRequest) => {
      const networkRequest =
        mockRequest.networkRequest as chrome.devtools.network.Request
      // Websocket mocks carry no body and no getContent
      return (
        typeof networkRequest.getContent === 'function' &&
        Boolean(networkRequest.request?.postData?.text)
      )
    })
    .map((mockRequest, index) => {
      const networkRequest =
        mockRequest.networkRequest as chrome.devtools.network.Request
      const requestId = `cdp-${index}`

      let body = ''
      networkRequest.getContent((content: string) => {
        body = content
      })
      cdpResponseBodies.set(requestId, body)

      const headers: Record<string, string> = {}
      ;(networkRequest.request.headers || []).forEach((header) => {
        headers[header.name] = header.value
      })

      return {
        requestWillBeSent: {
          requestId,
          request: {
            url: networkRequest.request.url,
            method: networkRequest.request.method,
            headers,
            postData: networkRequest.request.postData?.text,
          },
          timestamp: 1000 + index,
        },
        responseReceived: {
          requestId,
          response: {
            status: networkRequest.response.status,
            statusText: networkRequest.response.statusText,
            headers: { 'content-type': 'application/json' },
            encodedDataLength: networkRequest.response.bodySize,
          },
        },
        loadingFinished: {
          requestId,
          timestamp: 1000 + index + 1.1,
          encodedDataLength: networkRequest.response.bodySize,
        },
      }
    })
}
const handleKeydown = (e: KeyboardEvent) => {
  if (e.code === 'Digit1') {
    mockRequests.forEach(async (request) => {
      eventEmitter.emit('onBeforeRequest', {
        data: request.webRequestBodyDetails,
      })
      await wait(100)
      eventEmitter.emit('onBeforeSendHeaders', {
        data: request.webRequestHeaderDetails,
      })
      await wait(100)
      eventEmitter.emit('onRequestFinished', { data: request.networkRequest })
    })
  }
}
window.addEventListener('keydown', handleKeydown)

const mockedChrome: DeepPartial<typeof chrome> = {
  devtools: {
    inspectedWindow: {
      tabId: 1,
    },
    panels: {
      themeName: 'dark',
    },
    network: {
      getHAR: (cb) => {
        cb({
          entries: mockRequests.map(
            (mockRequest) => mockRequest.networkRequest
          ),
        } as any)
      },
      onRequestFinished: {
        addListener: (cb) => {
          eventEmitter.on('onRequestFinished', (event) => {
            cb(event.data)
          })
        },
        removeListener: () => {
          eventEmitter.off('onRequestFinished')
        },
      },
      onNavigated: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
  },
  webRequest: {
    onBeforeSendHeaders: {
      addListener: (cb) => {
        eventEmitter.on('onBeforeSendHeaders', (event) => {
          cb(event.data)
        })
      },
      removeListener: () => {
        eventEmitter.off('onBeforeSendHeaders')
      },
    },
    onBeforeRequest: {
      addListener: (cb) => {
        eventEmitter.on('onBeforeRequest', (event) => {
          cb(event.data)
        })
      },
      removeListener: () => {
        eventEmitter.off('onBeforeRequest')
      },
    },
  },
  runtime: {
    getPlatformInfo: ((cb) => {
      const platformInfo: chrome.runtime.PlatformInfo = {
        arch: 'x86-64',
        nacl_arch: 'x86-64',
        os: 'mac',
      }
      cb(platformInfo)
    }) as typeof chrome.runtime.getPlatformInfo,
    onMessage: {
      addListener: () => {},
      removeListener: () => {},
    },
  },
  storage: {
    local: {
      get: ((keys, cb) => {
        return cb({ ...mockStorage })
      }) as typeof chrome.storage.local.get,
      set: async (items: Record<string, any>) => {
        mockStorage = { ...mockStorage, ...items }
      },
    },
  },
  debugger: {
    attach: ((
      _target: chrome.debugger.Debuggee,
      _version: string,
      callback?: () => void
    ) => {
      if (callback) callback()
      else return Promise.resolve()
    }) as typeof chrome.debugger.attach,
    detach: ((_target: chrome.debugger.Debuggee, callback?: () => void) => {
      if (callback) callback()
      else return Promise.resolve()
    }) as typeof chrome.debugger.detach,
    sendCommand: ((
      _target: chrome.debugger.Debuggee,
      method: string,
      commandParams?: object,
      callback?: (result?: object) => void
    ) => {
      let result: object | undefined

      if (method === 'Network.getResponseBody') {
        const requestId = (commandParams as { requestId?: string })?.requestId
        result = {
          body: cdpResponseBodies.get(requestId || '') || '',
          base64Encoded: false,
        }
      }

      if (callback) callback(result)
      else return Promise.resolve(result || {})
    }) as typeof chrome.debugger.sendCommand,
    onEvent: {
      addListener: (callback: DebuggerEventCallback) => {
        debuggerEventListeners.push(callback)

        // Replay the mock traffic so the panel has something to show. The
        // delay lets the caller finish attaching first.
        setTimeout(() => {
          buildCdpEvents().forEach((events) => {
            callback(
              { tabId: 1 },
              'Network.requestWillBeSent',
              events.requestWillBeSent
            )
            callback(
              { tabId: 1 },
              'Network.responseReceived',
              events.responseReceived
            )
            callback(
              { tabId: 1 },
              'Network.loadingFinished',
              events.loadingFinished
            )
          })
        }, 0)
      },
      removeListener: (callback: DebuggerEventCallback) => {
        const index = debuggerEventListeners.indexOf(callback)
        if (index > -1) {
          debuggerEventListeners.splice(index, 1)
        }
      },
    },
  },
}

const mockChrome = mockedChrome as typeof chrome

export { mockChrome }
