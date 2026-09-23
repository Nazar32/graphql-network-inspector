/**
 * Send a diagnostic line to the background service worker.
 *
 * The devtools page has no console that is easy to reach, so the lines are
 * forwarded to the service worker instead. Open them from chrome://extensions
 * with the "service worker" link under this extension.
 *
 * @param event a short name for what happened
 * @param data any values that help explain the event
 */
export const logDiagnostic = (event: string, data?: unknown): void => {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return
    }

    chrome.runtime.sendMessage({ __gniDiagnostic: true, event, data }, () => {
      // Read lastError so that Chrome does not report an unchecked error
      void chrome.runtime.lastError
    })
  } catch (e) {
    // Diagnostics must never break the panel
  }
}
