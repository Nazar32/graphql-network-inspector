import { chromeProvider } from './chromeProvider'

/**
 * A listener for Chrome DevTools Protocol events.
 */
export type DebuggerEventListener = (method: string, params: any) => void

const listeners = new Set<DebuggerEventListener>()

let attachedTabId: number | null = null
let attachCount = 0
let attachPromise: Promise<boolean> | null = null

const handleEvent = (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object
) => {
  if (source.tabId !== attachedTabId) {
    return
  }

  listeners.forEach((listener) => listener(method, params as any))
}

const detachListeners = new Set<(reason?: string) => void>()

const handleDetach = (source: chrome.debugger.Debuggee, reason?: string) => {
  if (source.tabId !== attachedTabId) {
    return
  }

  attachedTabId = null
  attachPromise = null

  detachListeners.forEach((listener) => listener(reason))
}

/**
 * Listen for the debugger being detached.
 *
 * Chrome drops the attachment on some navigations, which stops every event
 * without warning. A caller uses this to attach again.
 *
 * @param listener called with the reason Chrome gave
 * @returns a function that removes the listener
 */
export const addDetachListener = (
  listener: (reason?: string) => void
): (() => void) => {
  detachListeners.add(listener)
  return () => {
    detachListeners.delete(listener)
  }
}

/**
 * Report whether the debugger is currently attached.
 */
export const isDebuggerAttached = (): boolean => attachedTabId !== null

const doAttach = (tabId: number): Promise<boolean> => {
  const chrome = chromeProvider()

  return new Promise<boolean>((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message

        // Chrome reports this when we are already attached, which is not a
        // failure for our purposes.
        if (message?.includes('Another debugger is already attached')) {
          attachedTabId = tabId
          resolve(true)
          return
        }

        resolve(false)
        return
      }

      attachedTabId = tabId
      resolve(true)
    })
  })
}

/**
 * Attach the debugger to a tab.
 *
 * Chrome allows one attachment per tab, but several parts of the panel need
 * the protocol at the same time. Every caller shares one attachment, which
 * is released when the last caller detaches.
 *
 * @param tabId the tab to attach to
 * @returns true if the debugger is attached
 */
export const attachDebugger = (tabId: number): Promise<boolean> => {
  attachCount += 1
  return ensureDebuggerAttached(tabId)
}

/**
 * Make sure the debugger is attached, without claiming another hold on it.
 *
 * Use this to attach again after Chrome has dropped the session.
 *
 * @param tabId the tab to attach to
 * @returns true if the debugger is attached
 */
export const ensureDebuggerAttached = (tabId: number): Promise<boolean> => {
  if (attachPromise) {
    return attachPromise
  }

  const chrome = chromeProvider()
  chrome.debugger.onEvent.removeListener(handleEvent)
  chrome.debugger.onDetach?.removeListener(handleDetach)
  chrome.debugger.onEvent.addListener(handleEvent)
  chrome.debugger.onDetach?.addListener(handleDetach)

  attachPromise = doAttach(tabId)
  return attachPromise
}

/**
 * Release one caller's hold on the debugger.
 *
 * @param tabId the tab to detach from
 */
export const detachDebugger = (tabId: number): void => {
  attachCount = Math.max(0, attachCount - 1)

  if (attachCount > 0) {
    return
  }

  const chrome = chromeProvider()
  chrome.debugger.onEvent.removeListener(handleEvent)
  chrome.debugger.onDetach?.removeListener(handleDetach)

  if (attachedTabId === tabId) {
    chrome.debugger.detach({ tabId }, () => {
      // The tab may already be closed, which is not an error worth showing
      void chrome.runtime.lastError
    })
  }

  attachedTabId = null
  attachPromise = null
}

/**
 * Send one protocol command.
 *
 * @param tabId the attached tab
 * @param method the protocol method, such as "Network.enable"
 * @param params the command parameters
 * @returns the command result, or undefined if the command failed
 */
export const sendDebuggerCommand = <T>(
  tabId: number,
  method: string,
  params?: object
): Promise<T | undefined> => {
  const chrome = chromeProvider()

  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        console.warn(
          '[GraphQL Network Inspector]',
          method,
          'failed:',
          chrome.runtime.lastError.message
        )
        resolve(undefined)
        return
      }

      resolve(result as T)
    })
  })
}

/**
 * Listen for protocol events on the attached tab.
 *
 * @param listener called with the event name and its parameters
 * @returns a function that removes the listener
 */
export const addDebuggerListener = (
  listener: DebuggerEventListener
): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
