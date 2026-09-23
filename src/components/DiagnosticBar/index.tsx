import { useEffect, useState } from 'react'
import { diagnosticCounters, diagnosticInfo } from '../../services/diagnostics'

/**
 * Show the live protocol counters at the top of the panel.
 *
 * This exists only to investigate issue #204. Remove it once the cause is
 * settled.
 */
const DiagnosticBar = () => {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 500)
    return () => clearInterval(id)
  }, [])

  const counters = diagnosticCounters
  const totals = [
    `setup:${counters.cdpSetup || 0}/${counters.cdpTeardown || 0}`,
    `attached:${diagnosticInfo.cdpAttached || '?'}`,
    `enable:${diagnosticInfo.cdpEnabled || '?'}`,
    `events:${counters.cdpEventAny || 0}`,
    `kept:${counters.cdpEventKept || 0}`,
    `dropped:${counters.cdpEventDropped || 0}`,
    `req:${counters.cdpRequest || 0}`,
    `graphql:${counters.cdpGraphql || 0}`,
    `resp:${counters.cdpResponse || 0}`,
    `finished:${counters.cdpFinished || 0}`,
    `body:${counters.cdpBody || 0}`,
  ].join('  ')

  return (
    <div className="fixed top-0 left-0 right-0 bg-black text-yellow-400 font-mono text-xs p-2 z-50 break-all border-b border-yellow-700">
      <div>CDP {totals}</div>
      <div>ROWS {diagnosticInfo.cdpRows}</div>
      <div>LAST {diagnosticInfo.cdpBody}</div>
      <div>EVENT {diagnosticInfo.cdpLastEvent}</div>
      <div>ERROR {diagnosticInfo.cdpLastError}</div>
    </div>
  )
}

export default DiagnosticBar
