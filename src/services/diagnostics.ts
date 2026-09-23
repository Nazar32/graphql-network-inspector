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

/**
 * Live counters shown in the panel, so the state can be read from a
 * screenshot without opening any console.
 */
export const diagnosticCounters: Record<string, number> = {
  before: 0,
  finished: 0,
  gate: 0,
  content: 0,
  matched: 0,
  postData: 0,
  har: 0,
}

/**
 * Add one to a counter.
 *
 * @param name the counter to raise
 */
export const bumpCounter = (name: string, by = 1): void => {
  diagnosticCounters[name] = (diagnosticCounters[name] || 0) + by
}

/**
 * The raw values of the most recent events, shown in the panel so they can
 * be read from a screenshot.
 */
export const diagnosticInfo: Record<string, string> = {
  finished: '(none yet)',
  content: '(none yet)',
}

/**
 * Record the raw values of an event.
 *
 * @param name the event to record
 * @param value a short description of the values
 */
export const setInfo = (name: string, value: string): void => {
  diagnosticInfo[name] = value
}
