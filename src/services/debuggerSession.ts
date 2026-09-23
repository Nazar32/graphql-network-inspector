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

const handleDetach = (source: chrome.debugger.Debuggee) => {
  if (source.tabId !== attachedTabId) {
    return
  }

  attachedTabId = null
  attachCount = 0
  attachPromise = null
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

  if (attachPromise) {
    return attachPromise
  }

  const chrome = chromeProvider()

  attachPromise = new Promise<boolean>((resolve) => {
    chrome.debugger.onEvent.addListener(handleEvent)
    chrome.debugger.onDetach?.addListener(handleDetach)

    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        console.warn(
          '[GNI] debugger attach failed',
          chrome.runtime.lastError.message
        )
        resolve(false)
        return
      }

      attachedTabId = tabId
      resolve(true)
    })
  })

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
